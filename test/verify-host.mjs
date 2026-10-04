// 宿主半验证：用真实 lib/index.js 挂到一个假 webServer 上，检查路由返回是否含 ruleKeys
import { readFileSync } from 'node:fs';

const mod = await import('../lib/index.js');

console.log('=== 模块导出 ===');
console.log('  name   =', mod.name);
console.log('  inject =', JSON.stringify(mod.inject));
console.log('  apply  =', typeof mod.apply);

// 假 ctx：捕获注册的路由
const routes = new Map();
const ctx = {
  webServer: { register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path); } },
  effect: (fn) => { fn(); },
  logger: { warn: (m) => console.log('  [host warn]', m) },
};

mod.apply(ctx, {});
console.log('\n=== 注册的路由 ===');
for (const p of routes.keys()) console.log('  ', p);

// 调用 overview handler，捕获响应
function callRoute(path, method = 'GET', remoteAddress = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const route = routes.get(path);
    if (!route) return reject(new Error('route not found: ' + path));
    const chunks = [];
    const res = {
      writeHead: (s, h) => { res._status = s; res._headers = h; },
      end: (b) => resolve({ status: res._status, body: JSON.parse(b) }),
    };
    const req = {
      method, socket: { remoteAddress },
      on: (ev, fn) => { if (ev === 'end') fn(); if (ev === 'data') { /* no body */ } },
      destroy: () => {},
    };
    route.handler(req, res);
  });
}

const ov = await callRoute('/api/dsh-hook/overview');
console.log('\n=== GET /api/dsh-hook/overview ===');
console.log('  status:', ov.status);
console.log('  顶层键:', Object.keys(ov.body).join(', '));
console.log('  ruleKeys 存在:', 'ruleKeys' in ov.body ? '✅' : '❌');
console.log('  ruleKeys 内容:', JSON.stringify(ov.body.ruleKeys?.map((k) => k.key)));
console.log('  hooks 数:', ov.body.hooks.length, '| rules:', JSON.stringify(ov.body.rules), '| runs:', ov.body.runs.length);
console.log('  hooksPath:', ov.body.hooksPath);
console.log('  loadError:', JSON.stringify(ov.body.loadError));

// 一致性：ruleKeys 的 key 必须与 rules 对象的 key 完全对应
const ruleKeys = ov.body.ruleKeys.map((k) => k.key);
const ruleObjKeys = Object.keys(ov.body.rules);
const same = JSON.stringify([...ruleKeys].sort()) === JSON.stringify([...ruleObjKeys].sort());
console.log('\n  ruleKeys 与 rules 键一致:', same ? '✅' : '❌ ' + JSON.stringify({ ruleKeys, ruleObjKeys }));

// 每条 ruleKey 都要在客户端字典里有 zh/en 条目
const clientSrc = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
let missing = [];
for (const k of ruleKeys) {
  for (const suffix of ['', '.desc']) {
    const key = `'hook.rule.${k}${suffix}'`;
    const count = clientSrc.split(key).length - 1;
    if (count < 2) missing.push(`${k}${suffix} (出现 ${count} 次，zh/en 应各 1)`);
  }
}
console.log('  客户端 zh/en 字典覆盖:', missing.length === 0 ? '✅ 全部齐备' : '❌ 缺 ' + missing.join(', '));

const fail = !('ruleKeys' in ov.body) || !same || missing.length > 0;
console.log('\n' + (fail ? '❌ 宿主半验证未通过' : '✅ 宿主半验证通过'));
process.exit(fail ? 1 : 0);
