// 端到端渲染验证：用真实 client.js + 真实 API 数据，在一个极简 DOM 上跑 renderRows
// 目的：证明修复后不再抛异常，且所有卡片都能渲染出来。
import { readFileSync } from 'node:fs';

const clientSrc = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// ---- 极简 DOM 桩（只实现渲染路径用到的 API）----
class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attrs = {}; this._html = ''; this.listeners = {}; }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  get innerHTML() { return this._html; }
  setAttribute(k, v) { this.attrs[k] = v; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  get textContent() { return this._html; }
}
const doc = {
  documentElement: { lang: 'zh' },
  createElement: (t) => new El(t),
  getElementById: () => null,
  head: new El('head'),
  body: new El('body'),
  querySelector: () => null,
  querySelectorAll: () => [],
};
global.document = doc;
global.MutationObserver = class { observe() {} disconnect() {} };
global.requestAnimationFrame = (fn) => fn();

// ---- 从 client.js 抽出「浏览器半」的真实实现（不重新实现任何逻辑）----
const start = clientSrc.indexOf("const SECTION_ID");
const end = clientSrc.indexOf("/** Imperative DOM mount");
const body = clientSrc.slice(start, end);

const harness = `
${body}
return { renderRows, relTime, t, dictionary, renderRulesCard, renderRunsCard };
`;
// zh/en 字典已包含在 body 中
const make = new Function(harness);
const api = make();

// ---- 真实 API 数据（本次轮询实测取得）----
const docData = {
  hooksPath: 'D:\\deepseek harness\\dsh-data\\hooks.json',
  loadError: null,
  total: 3,
  hooks: [
    { event: 'SessionStart', matcher: null, command: 'node "D:/.../hook-context.mjs"', timeout: 10, statusMessage: '注入会话上下文', type: 'command' },
    { event: 'PreToolUse', matcher: 'pwsh|Bash|write|edit', command: 'node "D:/.../hook-guard.mjs"', timeout: 10, statusMessage: '守卫', type: 'command' },
    { event: 'PostToolUse', matcher: 'pwsh', command: 'node "D:/.../hook-log.mjs"', timeout: 5, statusMessage: null, type: 'command' },
  ],
  rules: { recursion: true, cWrite: true, envProbe: true, bskJunction: true },
  ruleKeys: [
    { key: 'recursion', label: '递归删除保护', desc: '...' },
    { key: 'cWrite', label: 'C 盘写入保护', desc: '...' },
    { key: 'envProbe', label: '环境变量枚举拦截', desc: '...' },
    { key: 'bskJunction', label: '.bsk Junction 保护', desc: '...' },
  ],
  runs: [
    { time: '2026-10-04T13:01:47', decision: 'allow', tool: 'pwsh', cmd: 'echo final-check' },
    { time: '2026-10-04T12:52:47', decision: 'allow', tool: 'pwsh', cmd: 'echo tz-check' },
    { time: '2026-10-04T12:40:00', decision: 'block', tool: 'pwsh', cmd: 'Remove-Item -Recurse node_modules', reason: 'hook-guard: 递归删除触及受保护目录' },
  ],
  generatedAt: Date.now(),
};

const container = new El('div');
let crashed = null;
try {
  api.renderRows(container, docData);
} catch (e) {
  crashed = e;
}

if (crashed) {
  console.log('❌ renderRows 仍然抛异常:', crashed.constructor.name, '-', crashed.message);
  process.exit(1);
}

// renderRows 用 innerHTML='' 清空，然后 appendChild 卡片；检查渲染出的卡片数
const cards = container.children.length;
console.log('✅ renderRows 未抛异常');
console.log('   渲染出的顶层卡片数:', cards, '(期望 2 + 7 = 9：运行状态 + 守卫规则 + 7 个事件)');

const clearBtn = container.children.find((c) => c.className === 'hooks-panel-clearbtn');
console.log('   清空按钮:', clearBtn ? '已渲染 ✅' : '缺失 ❌');

// 语言切换验证：英文界面下规则卡标签应为英文
doc.documentElement.lang = 'en';
const enContainer = new El('div');
api.renderRulesCard(enContainer, docData);
doc.documentElement.lang = 'zh';
const zhContainer = new El('div');
api.renderRulesCard(zhContainer, docData);

const enHtml = enContainer.children[0].innerHTML;
const zhHtml = zhContainer.children[0].innerHTML;
console.log('');
console.log('   英文规则卡含 "Recursive delete protection":', enHtml.includes('Recursive delete protection') ? '✅' : '❌');
console.log('   中文规则卡含 "递归删除保护":', zhHtml.includes('递归删除保护') ? '✅' : '❌');
console.log('   英文卡不再泄露中文:', /[\u4e00-\u9fa5]/.test(enHtml.replace(/10′/g, '')) ? '❌ 仍有中文' : '✅');

console.log('');
console.log('=== relTime 渲染样本 ===');
for (const iso of ['2026-10-04T13:01:47', new Date().toISOString()]) {
  console.log('  ', iso, '->', JSON.stringify(api.relTime(iso)));
}
