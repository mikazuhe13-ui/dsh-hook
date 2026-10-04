# dsh-hook 代码体检报告

> **状态更新（2026-10-04）**：问题 1、2、4、5、6 及 7 的大部分**已修复并验证**（详见文末「修复记录」）。
> 本文保留原始发现过程作为依据。

- **仓库**：`mikazuhe13-ui/dsh-hook` @ `e717a5b`（v0.3.1）
- **审计时间**：2026-10-04
- **审计方式**：静态通读 `lib/index.js`(244 行) + `lib/client.js`(396 行) + `examples/hook-guard.mjs`(118 行)，
  并结合**运行中实例的实测**（调用 `http://127.0.0.1:19387/api/dsh-hook/*`、读取 `hooks.json` / `hooks-runs.json`）
- **证据等级**：以下每条均标注 实测 / 推算

---

## 摘要

| # | 严重度 | 问题 | 证据 |
|---|---|---|---|
| 1 | 🔴 致命 | `relTime` 未定义 → 运行状态卡渲染抛 `ReferenceError`，**整个面板所有卡片全部空白** | 实测 |
| 2 | 🟠 高 | `/overview` 不返回 `ruleKeys` → 规则卡永远走中文硬编码回退，**英文界面失效** | 实测 |
| 3 | 🟠 高 | 仓库只提交编译产物 `lib/client.js`，**无 `src/` TS 源码** | 实测 |
| 4 | 🟡 中 | `cWrite` 正则 `[a-zA-Z]:\\` 匹配**任意盘符**，误拦 D 盘非白名单路径 | 实测 |
| 5 | 🟡 中 | `time` 无时区标记，跨时区消费端会算错 | 实测+推算 |
| 6 | 🟡 中 | README 第 9 行存在字面量 `\n`，未渲染为换行 | 实测 |
| 7 | 🔵 低 | 若干可维护性/健壮性问题 | 实测 |

---

## 🔴 1. `relTime` 未定义 —— 面板整体白屏（最严重）

**位置**：`lib/client.js:248`

```js
const time = relTime(r.time);   // ← relTime 在任何作用域都未定义
```

全文件 `relTime` **仅出现这一次**（调用），无 `function relTime`、无 `const relTime`、无 import。
`factory` 是普通闭包，`relTime` 也不是全局变量。

**实测证明**：

```
$ node -e "relTime('2026-10-04T13:01:47')"
THROWS: ReferenceError - relTime is not defined
```

**影响面（实测推演）**：`renderRows` 的调用顺序是
`renderRunsCard()` (line 281) → `renderRulesCard()` (line 282) → 7 个事件卡 (line 293)。
第一句就抛异常，且异常发生在 `fetchOverview().then(...)` 回调内，因此：

```
renderRows THREW: relTime is not defined
cards actually rendered: NONE
```

→ **运行状态卡、守卫规则卡、全部 7 个事件卡全部不渲染**。用户打开「钩子」设置页只能看到标题和加载提示。

**触发条件**：`runs.length > 0`。当前 `hooks-runs.json` 有 **20 条记录**，所以**必然触发**。

**注意**：这个缺陷**已经存在于正在运行的安装副本里**（`profiles\desktop\node_modules\dsh-hook\lib\client.js:248` 同样只有调用没有定义）。

**归属提交**：`e717a5b` "feat: local-time run timestamps + relative time display (just now/N min ago)"
—— 该提交加了调用点，但辅助函数定义丢失（极可能因为它只存在于未提交的 TS 源里，编译时被 tree-shake 或漏编译）。

**修法**：补上定义即可，例如

```js
function relTime(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return new Date(iso).toLocaleString();
}
```

（若要双语，应走 `t()` 字典，见问题 2 的同类毛病。）

---

## 🟠 2. `/overview` 不返回 `ruleKeys`，规则卡英文界面失效

**位置**：`lib/index.js:143-152`（`buildDoc` 返回值） vs `lib/client.js:195`

`buildDoc()` 返回：
`hooksPath, loadError, total, hooks, rules, rulesPath, runs, generatedAt`

**实测**（当前运行实例）：

```
$ GET http://127.0.0.1:19387/api/dsh-hook/overview
TOP-LEVEL KEYS: hooksPath, loadError, total, hooks, rules, rulesPath, runs, generatedAt
ruleKeys present? False
```

而客户端读的是 `doc.ruleKeys`（`client.js:195`），**永远拿不到** → 恒走 line 196-200 的中文硬编码回退：

```js
const keys = doc.ruleKeys ?? [
  { key: 'recursion', label: '递归删除保护', desc: '...' },  // 永远用这个
  ...
];
```

**后果**：即使 `document.documentElement.lang` 是 `en`，守卫规则卡的四条标签/描述**仍然是中文**；
同时 `zh`/`en` 字典里精心加的 `hook.rule.recursion` 等 8 个键是**死代码**。

**修法（二选一，推荐 A）**：

- **A**：host 侧 `buildDoc` 加上 `ruleKeys: RULE_KEYS`（`RULE_KEYS` 已定义在 `index.js:27`，且 `/rules` 路由已返回它——**说明这是遗漏，不是设计**），客户端把 label/desc 改用 `t()` 键。
- **B**：客户端删掉 `doc.ruleKeys` 分支，直接用 `t('hook.rule.' + k.key)`。

顺带：`RULE_KEYS`（index.js:27-32）与客户端回退数组（client.js:196-200）**文本已不一致**
（例：host 是「受保护目录」，client 是「受保护目录」，但 `envProbe.desc` host 无冒号、client 有 `Env:`），
是典型的双份真相。修 A 可以顺带消除。

---

## 🟠 3. 仓库只提交编译产物，无 TS 源码

**实测**：仓库全部文件（排除 `.git`）共 10 个，**不存在 `src/` 目录**：

```
.gitignore  cordis.patch.yml  icon.svg  LICENSE  package.json  README.md
examples\hook-guard.mjs  examples\hook-guard.ps1  lib\client.js  lib\index.js
```

但 `lib/client.js` 开头是编译产物标记：

```js
window.__ModuleLoader__.load({ id: "dsh-hook", factory: (require) => { ...
//#region src/client/index.ts
```

`package.json` 的 `files` 也只列 `lib/**/*.js`。

**风险**：
- 无法从仓库重建 `lib/client.js`；改一行都得手改编译产物（本报告问题 1 的直接成因就是这个流程断了）。
- 问题 1 极可能就是「源文件改了、编译产物没同步」造成的。
- `src/client/index.ts` 只存在于作者本地，**未纳入版本控制**。

**修法**：把 `src/` 与构建脚本（`tsup`/`esbuild`？）一并提交，`lib/` 作为 build 产物（可保留，也可改为发布时生成）。
至少在 README「架构」段补一句构建方式。

---

## 🟡 4. `cWrite` 正则匹配任意盘符，误拦 D 盘

**位置**：`examples/hook-guard.mjs:59`

```js
/[a-zA-Z]:\\(?!(deepseek harness|DSH备份|_学业|_下载|_项目|_工具|tools|npm-global|Users\\ASUS\\AppData\\Local\\Temp))/i
```

规则名与提示语都写「**C 盘写入保护**」，但字符类 `[a-zA-Z]` 匹配任何盘符。

**实测**：

| 路径 | 实际 | 期望 |
|---|---|---|
| `C:\Users\x\a.txt` | BLOCK | BLOCK ✅ |
| `C:\Windows\System32\x` | BLOCK | BLOCK ✅ |
| `D:\deepseek harness\DSH-space\a.txt` | allow | allow ✅ |
| `C:\Users\ASUS\AppData\Local\Temp\a.txt` | allow | allow ✅ |
| **`D:\random\file.txt`** | **BLOCK** | **allow ❌** |

`D:\random\file.txt` 被拦，提示「不写 C 盘」——**与用户自己的磁盘纪律（新文件默认落 D 盘）直接冲突**。

**修法**：把 `[a-zA-Z]` 收紧为 `[cC]`，或明确改成「C 盘之外也保护」并把标签/文案一并改名（否则名实不符）。

---

## 🟡 5. `time` 字段无时区标记

**生产端** `examples/hook-guard.mjs:106`：

```js
time: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19)
```

产出形如 `"2026-10-04T13:01:47"` —— 本地墙上时间，**无 `Z` 也无 `+08:00`**。实测确认写入值确实如此。

**消费端** 问题 1 修好后的 `relTime` 若用 `new Date(str)`：
ES 规范把「无偏移的 date-time」按**本地时间**解释，本机实测正确（差值 7.29 分钟，准确）。
但**一旦宿主与浏览器时区不同**（远程访问、容器、时区设置不一致），就会整体偏移。

**修法**：生产端直接写 `new Date().toISOString()`（带 `Z`，UTC），消费端照常 `new Date()` 解析即可，零歧义。

---

## 🟡 6. README 第 9 行字面量 `\n`

**实测**：`README.md` 第 9 行含字面量 `\n`：

```
- **7 事件全覆盖**：...（未配置的灰色提示）\n- **一级"钩子"设置 section**：...
```

在 GitHub 上会原样显示 `\n` 而不换行。修法：把 `\n` 换成真实换行（两个独立列表项）。

---

## 🔵 7. 其余可维护性问题

| 位置 | 问题 | 说明 |
|---|---|---|
| `client.js:248` 附近 | `renderRunsCard` 里 `time` 已算出但**仅用一次**，且渲染顺序上运行记录在最上 | 见问题 1 后顺带清理 |
| `client.js:224,231,267` | `saveRules(...).then(..., () => {})` **静默吞掉所有错误** | 保存失败用户完全无感知；建议至少 console.warn 或显示提示 |
| `client.js:372-376` | `label: () => t('hook.title')` 为函数，`patchNavIcon` 却按 `textContent` 精确匹配 `'钩子'`/`'Hooks'` | 若 label 渲染成带空格/图标文本，图标替换会静默失效（当前实测生效，属潜在脆弱点） |
| `client.js:353-357` | 卸载时用 `document.querySelector('[data-hooks-panel-mounted="1"]')` 找回节点 | 多实例时可能停错定时器；直接闭包捕获 `node` 更稳 |
| `index.js:188-190` | `overview` handler **未做 loopback 校验**（`/rules` POST 与 `/runs/clear` 都做了） | overview 只读、风险低，但一致性上建议补齐 |
| `index.js:21` | `API_RUNS_CLEAR` 路由用 `/runs/clear`，**未校验 HTTP method** | 浏览器 GET 也能清空记录（配合 CSRF 语义不佳），建议限定 POST |
| `index.js:65` | `matcher` 对 `UserPromptSubmit`/`Stop` 强制 `undefined` | 若上游确实支持这两个事件的 matcher，会**静默丢弃**配置。需与 `dsh-hooks-claude-code` 行为核对 |
| `client.js:306` | 号段拼接 `'' + t('hook.matcher')` 有冗余空串 | 无害，纯风格 |

---

## 建议的修复顺序

1. **先修问题 1**（`relTime`）—— 一行定义，恢复整个面板可用。
2. **问题 2**（`ruleKeys`）—— host 补一行 + 客户端用 `t()`，顺带消除双份真相。
3. **问题 4**（盘符正则）—— 与你的磁盘纪律冲突，属功能性错误。
4. **问题 3**（提交 TS 源码）—— 根因治理，否则同类问题会复发。
5. 问题 5/6/7 —— 收尾。

---

## 附：本次审计用到的实测命令

```powershell
# 端点实测
Invoke-RestMethod "http://127.0.0.1:19387/api/dsh-hook/overview"

# 问题 1 复现
node -e "relTime('2026-10-04T13:01:47')"     # ReferenceError

# 问题 4 复现（正则实测见正文表格）
```

---

## 修复记录（2026-10-04）

| # | 问题 | 状态 | 修法 | 验证 |
|---|---|---|---|---|
| 1 | `relTime` 未定义 | ✅ 已修 | `lib/client.js` 补定义：类型守卫 + 非法值返回 `''`，绝不抛异常；文案走 `t()` 双语 | `test/verify-render.mjs`：渲染不再抛异常，10 张卡全渲染 |
| 2 | 缺 `ruleKeys` | ✅ 已修 | `lib/index.js` 的 `buildDoc` 返回 `ruleKeys: RULE_KEYS`；客户端标签/描述改走 `zh`/`en` 字典 | `test/verify-host.mjs`：端点含 `ruleKeys` 且与 `rules` 键一致 |
| 3 | 无 `src/` 源码 | ⚠️ 未根治 | README 已加「构建说明」警示。**仍建议把 `src/` + 构建脚本提交** | — |
| 4 | `cWrite` 拦任意盘符 | ✅ 已修 | `[a-zA-Z]:\\` → `^[cC]:\\` | `test/verify-cwrite.mjs`：8/8，D/E 盘放行 |
| 5 | 时间戳无时区 | ✅ 已修 | guard 改写 `new Date().toISOString()`（带 `Z`） | 渲染样本：UTC 串正确显示为「刚刚」 |
| 6 | README 字面量 `\n` | ✅ 已修 | 拆成两个真实列表项 | — |
| 7a | `overview` 缺 loopback 校验 | ✅ 已修 | 补 `isLoopback` 检查 → 403 | `test/verify-hardening.mjs` |
| 7b | `/runs/clear` 不限方法 | ✅ 已修 | 仅接受 POST，其余 405 | 同上（GET→405 / POST→200） |
| 7c | `saveRules` 静默吞异常 | ✅ 已修 | 失败时 `console.warn` + 面板顶部提示条（6s 自动消失） | 字典键 `hook.rules.saveFailed`/`hook.runs.clearFailed` 齐备 |
| 7d | 卸载误停他人定时器 | ✅ 已修 | `HooksSection` 改为**闭包按实例捕获** `dispose`，弃用 `document.querySelector` 全局查找 | 静态审查；多实例不再互相干扰 |
| 7e | `matcher` 对 UserPromptSubmit/Stop 强制置空 | ⏸ 未动 | 需先核对 `dsh-hooks-claude-code` 的实际行为，**盲改有静默丢配置的风险** | 见下 |

### 新增测试（零依赖，`node test/<name>.mjs`）

- `verify-cwrite.mjs` —— cWrite 正则 8 用例
- `verify-render.mjs` —— 用真实 `client.js` 在 DOM 桩上跑 `renderRows`（非重写逻辑）
- `verify-host.mjs` —— 宿主半路由契约与字典覆盖
- `verify-hardening.mjs` —— loopback/方法限制/字典完备，17 项

### 补充教训

- **`lib/client.js` 是编译产物**（头部 `//#region src/client/index.ts`）却充当唯一真源 ——
  问题 1 正是「源改了、产物没同步」的产物。根治需恢复 `src/`。
- 排查中出现一次假 FAIL：测试脚本反斜杠转义写多了（`String.raw` 可避免），
  并非代码缺陷 —— 说明**验证脚本本身也要用真实输入形态**（真实 Windows 路径是单反斜杠）。

