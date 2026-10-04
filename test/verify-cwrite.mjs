// 校验 hook-guard.mjs 的 cWrite 正则：只拦 C 盘，放行其他盘符与白名单
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../examples/hook-guard.mjs', import.meta.url), 'utf8');
const m = src.match(/\/\^\[cC\]:.*?\/i/);
if (!m) { console.error('FAIL: 未能在 hook-guard.mjs 中找到 cWrite 正则'); process.exit(1); }
const re = new RegExp(m[0].slice(1, -2), 'i');
console.log('regex =', m[0], '\n');

// 用 String.raw 保证每个反斜杠都是字面量（Windows 路径真实形态）
const R = String.raw;
const cases = [
  [R`C:\Users\x\a.txt`,                      true,  'C盘非白名单 -> 拦'],
  [R`c:\windows\system32\x`,                 true,  '小写 c 盘 -> 拦'],
  [R`C:\Windows\Temp\x`,                     true,  'C盘其他 -> 拦'],
  [R`D:\random\file.txt`,                    false, 'D盘 -> 放行（本次修复点）'],
  [R`D:\deepseek harness\DSH-space\a.txt`,   false, 'D盘工作区 -> 放行'],
  [R`D:\tools\Git\x`,                        false, 'D盘 tools -> 放行'],
  [R`E:\whatever\x`,                         false, 'E盘 -> 放行'],
  [R`C:\Users\ASUS\AppData\Local\Temp\a.txt`,false, 'C盘 Temp 白名单 -> 放行'],
];

let bad = 0;
for (const [p, want, label] of cases) {
  const got = re.test(p);
  const ok = got === want;
  if (!ok) bad++;
  console.log((ok ? 'PASS' : 'FAIL'), (got ? 'BLOCK' : 'allow').padEnd(6), '|', label.padEnd(26), '|', p);
}
console.log('\n' + (bad === 0 ? 'ALL PASS' : bad + ' FAILED'));
process.exit(bad === 0 ? 0 : 1);
