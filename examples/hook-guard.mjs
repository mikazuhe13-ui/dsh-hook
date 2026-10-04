// hook-guard.mjs — PreToolUse 守卫（node 版，~55ms，规则级开关实时生效，JSON 决策协议）
// 用法：hooks.json 的 PreToolUse command 指向本文件：
//   node "D:/deepseek harness/dsh-data/scripts/hook-guard.mjs"
// 规则开关：<dsh-home>/hooks-rules.json（recursion/cWrite/envProbe，缺省 true）
//   设置界面的钩子面板（dsh-hook 插件）可读写这个文件，实时生效无需重启。
// 决策协议：exit 2 + stderr 在部分桥实现里不被当作阻塞（记录为 hook 失败）；
//   改用 **stdout JSON 决策**（claude-code 协议标准）：blocked 时 stdout 输出
//   {"decision":"block","reason":"..."}，桥解析后真正阻塞工具调用。
// 输入：stdin JSON { tool_name, tool_input }
import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  // 规则开关（每次调用读一次，1KB 内文件，~0.1ms；开关改动实时生效）
  let rules = {};
  try {
    const candidates = [];
    const dshHome = process.env.DSH_HOME;
    if (dshHome) candidates.push(join(dshHome, 'hooks-rules.json'));
    candidates.push(join(homedir(), '.dsh-hook', 'rules.json'));
    for (const p of candidates) {
      if (existsSync(p)) {
        let text = readFileSync(p, 'utf8');
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        rules = JSON.parse(text) ?? {};
        break;
      }
    }
  } catch { rules = {}; }
  // 规则值两种形态：true/false（永久开关）或 { until: epoch-ms }（临时关闭，到期自动恢复）
  const on = (k) => {
    const v = rules[k];
    if (v && typeof v === 'object' && v.until) return Date.now() >= v.until; // 临时关闭期内 = false，到期 = true
    return v !== false; // 缺省 true
  };

  let j;
  try { j = JSON.parse(raw); } catch { process.exit(0); }
  const tool = j.tool_name;
  if (!tool) process.exit(0);

  let cmd = '';
  if (tool === 'pwsh' || tool === 'Bash') cmd = String(j.tool_input?.command ?? '');
  else if (tool === 'write' || tool === 'edit') cmd = String(j.tool_input?.file_path ?? '');
  if (!cmd) process.exit(0);

  let block = null;
  const hitsTemp = /\$env:TEMP|%TEMP%|AppData\\Local\\Temp/i.test(cmd);

  // 1. 递归删除触及受保护目录（junction 穿透；含 .bsk / node_modules / profiles / skills）
  //    🔴 曾有独立的「.bsk Junction 保护」规则，与这里完全重叠（正则已含 \.bsk）——
  //    已删（重复 owner，两个开关管同一件事）。.bsk 由本规则统一覆盖。
  if (on('recursion') && !hitsTemp && /remove-item/i.test(cmd) && /-recurse/i.test(cmd) && /(node_modules|\.bsk|profiles|skills)/i.test(cmd)) {
    block = 'hook-guard: 递归删除触及受保护目录。若是 junction，Remove-Item -Recurse 会穿透删掉目标本体——用 [System.IO.Directory]::Delete(path) 只删链接。';
  }
  // 2. 写 C 盘非白名单路径（write/edit）。只针对 C 盘——其他盘符（尤其 D 盘工作区）放行。
  if (!block && on('cWrite') && (tool === 'write' || tool === 'edit') && /^[cC]:\\(?!(deepseek harness|DSH备份|_学业|_下载|_项目|_工具|tools|npm-global|Users\\ASUS\\AppData\\Local\\Temp))/i.test(cmd)) {
    block = 'hook-guard: 磁盘纪律——新文件默认放 D 盘工作区，不写 C 盘。';
  }
  // 3. 环境变量枚举（DSH 剥疑似密钥变量，结论不可信）
  if (!block && on('envProbe') && /Get-ChildItem\s+Env:|Get-Item\s+Env:|\[Environment\]::GetEnvironmentVariable/.test(cmd)) {
    block = 'hook-guard: 工具子进程的环境变量枚举结果不可信（疑似密钥变量被剥掉）。';
  }

  if (block) {
    // JSON 决策协议（stdout）：桥解析 decision:"block" 后真正阻塞，reason 模型可见
    logRun('block', tool, cmd, block);
    process.stdout.write(JSON.stringify({ decision: 'block', reason: block }));
    process.exit(0);
  }
  logRun('allow', tool, cmd, null);
  process.exit(0);
});

/**
 * 运行统计：每次调用追加到 <dsh-home>/hooks-runs.json（面板的「运行状态」卡片读它）。
 * 原子写（tmp+rename），只保留最近 20 条；失败静默（统计绝不能影响守卫本身）。
 */
function logRun(decision, tool, cmd, reason) { if (process.env.HOOK_GUARD_DEBUG) console.error("[logRun] called:", decision, tool);
  try {
    const candidates = [];
    const dshHome = process.env.DSH_HOME;
    if (dshHome) candidates.push(dshHome);
    const home = homedir();
    candidates.push(join(home, '.dsh-hook'));
    let dir = null;
    for (const c of candidates) {
      try { mkdirSync(c, { recursive: true }); dir = c; break; } catch {}
    }
    if (!dir) return;
    const file = join(dir, 'hooks-runs.json');
    let runs = [];
    try {
      let text = readFileSync(file, 'utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed?.runs)) runs = parsed.runs;
    } catch {}
    runs.unshift({
      // ISO-8601 带 Z（UTC）：无时区歧义，消费端 new Date() 直接正确解析
      time: new Date().toISOString(),
      decision,
      tool,
      // 只留命令首行 + 截断，避免统计文件膨胀
      cmd: String(cmd).split('\n')[0].slice(0, 160),
      ...(reason ? { reason: String(reason).slice(0, 160) } : {}),
    });
    runs = runs.slice(0, 20);
    const tmpFile = file + '.tmp';
    writeFileSync(tmpFile, JSON.stringify({ runs }, null, 1), 'utf8');
    renameSync(tmpFile, file);
  } catch { /* 统计失败不影响守卫 */ }
}
