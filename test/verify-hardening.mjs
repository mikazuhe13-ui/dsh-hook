// #7 加固验证：loopback 校验、方法限制、字典完备性
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const mod = await import('../lib/index.js');

const routes = new Map();
const ctx = {
  webServer: { register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path); } },
  effect: (fn) => { fn(); },
  logger: { warn: () => {} },
};
mod.apply(ctx, {});

function call(path, { method = 'GET', remoteAddress = '127.0.0.1', body } = {}) {
  return new Promise((resolve) => {
    const route = routes.get(path);
    const res = {
      writeHead: (s) => { res._status = s; },
      end: (b) => resolve({ status: res._status, body: JSON.parse(b) }),
    };
    const handlers = {};
    const req = {
      method, socket: { remoteAddress },
      on: (ev, fn) => { handlers[ev] = fn; },
      destroy: () => {},
    };
    route.handler(req, res);
    // 模拟 body 流结束
    if (body !== undefined && handlers.data) handlers.data(Buffer.from(body));
    if (handlers.end) handlers.end();
  });
}

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log((ok ? 'PASS' : 'FAIL'), name.padEnd(52), 'got=' + got, ok ? '' : 'want=' + want);
};

console.log('=== loopback 校验 ===');
check('overview 非 loopback → 403', (await call('/api/dsh-hook/overview', { remoteAddress: '10.0.0.5' })).status, 403);
check('overview loopback → 200',     (await call('/api/dsh-hook/overview')).status, 200);
check('rules GET 非 loopback → 200(只读)', (await call('/api/dsh-hook/rules', { remoteAddress: '10.0.0.5' })).status, 200);
check('rules POST 非 loopback → 403', (await call('/api/dsh-hook/rules', { method: 'POST', remoteAddress: '10.0.0.5', body: '{}' })).status, 403);
check('runs/clear 非 loopback → 403', (await call('/api/dsh-hook/runs/clear', { method: 'POST', remoteAddress: '10.0.0.5' })).status, 403);

console.log('\n=== runs/clear 方法限制（新增）===');
// ⚠️ 安全：真实 handler 会 unlinkSync 掉 <DSH_HOME>/hooks-runs.json，
// 直接打真端点会**销毁真实运行记录**（本文件曾因此误删 20 条）。
// 这里用一个临时 DSH_HOME 做隔离，只验证方法/loopback 语义。
const tmpHome = mkdtempSync(join(tmpdir(), 'dsh-hook-test-'));
const savedHome = process.env.DSH_HOME;
process.env.DSH_HOME = tmpHome;
writeFileSync(join(tmpHome, 'hooks-runs.json'), JSON.stringify({ runs: [{ time: new Date().toISOString(), decision: 'allow', tool: 'test', cmd: 'x' }] }), 'utf8');

// 用隔离后的环境重新挂载路由（rulesPath/runsFile 每次调用才读 env，故同一实例也安全）
try {
  check('runs/clear GET → 405',  (await call('/api/dsh-hook/runs/clear', { method: 'GET' })).status, 405);
  check('runs/clear POST → 200', (await call('/api/dsh-hook/runs/clear', { method: 'POST' })).status, 200);
  check('runs/clear 确实清空（隔离副本）', existsSync(join(tmpHome, 'hooks-runs.json')), false);
} finally {
  if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome;
  rmSync(tmpHome, { recursive: true, force: true });
}

console.log('\n=== ruleKeys 契约 ===');
const ov = await call('/api/dsh-hook/overview');
check('overview 含 ruleKeys', Array.isArray(ov.body.ruleKeys), true);
const rk = ov.body.ruleKeys.map((k) => k.key);
check('ruleKeys 与 rules 键一致', JSON.stringify([...rk].sort()) === JSON.stringify(Object.keys(ov.body.rules).sort()), true);

console.log('\n=== 客户端字典覆盖 ruleKeys ===');
const c = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
let missing = [];
for (const k of rk) for (const sfx of ['', '.desc']) {
  const n = c.split(`'hook.rule.${k}${sfx}'`).length - 1;
  if (n < 2) missing.push(`hook.rule.${k}${sfx}`);
}
check('rule keys 全部有 zh+en', missing.length === 0, true);
if (missing.length) console.log('   缺:', missing.join(', '));

console.log('\n=== 动态引用的字典键也存在 ===');
for (const dyn of ['hook.time.now', 'hook.time.min', 'hook.time.hour', 'hook.time.day', 'hook.time.future', 'hook.rules.saveFailed', 'hook.runs.clearFailed']) {
  const n = c.split(`'${dyn}'`).length - 1;
  check(`字典含 ${dyn} (zh+en)`, n >= 2, true);
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
