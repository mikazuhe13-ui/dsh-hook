# 钩子面板（dsh-hook）

DSH（DeepSeek Harness）的生命周期钩子设置面板插件 —— 在设置界面列出已配置的钩子（`hooks.json`）：事件、matcher、命令、超时与状态信息，风格对齐 Codex Desktop 的钩子页。

![icon](icon.svg)

## 功能

- **7 事件全覆盖**：SessionStart（含会话上下文注入示例脚本）/ PreToolUse / PostToolUse / UserPromptSubmit / Stop / SubagentStart / SubagentStop——面板按固定顺序显示全部事件（未配置的灰色提示）
- **一级“钩子”设置 section**：侧栏设置页新增“钩子”入口
- **按事件分组显示**：PreToolUse / PostToolUse / SessionStart / UserPromptSubmit / Stop / SubagentStart / SubagentStop
- **每条钩子显示**：statusMessage、完整命令、matcher、timeout、类型
- **自动探测 hooks.json**：按 `$DSH_HOME/hooks.json` → `~/.claude/hooks.json` → `~/.codex/hooks.json` 顺序探测；也可在插件配置里显式指定 `hooksPath`
- **零后台开销**：路由按需读取文件（1 KB 级），轮询仅在设置页打开时进行（15s 间隔）
- **主题跟随**：颜色全部 `color-mix(in srgb, currentColor)`，浅色/深色/透明主题自动适配

## 安装

### 方式一：从 GitHub（推荐）

在 DSH profile 目录（`<dsh-home>/profiles/<name>/`）：

1. `package.json` 的 `dependencies` 加：

```json
"dsh-hook": "github:<你的用户名>/dsh-hook"
```

2. `dsh.profile.bundles` 数组加 `"dsh-hook"`
3. 运行 `pnpm install`
4. 重启 DSH

### 方式二：本地 link 开发

```json
"dsh-hook": "link:D:/path/to/dsh-hook"
```

> ⚠️ pnpm 对 scope 名 + `link:` 组合会报 `ERR_PNPM_INVALID_DEPENDENCY_NAME`，请用无 scope 包名。

## 配置

插件的 `cordis.patch.yml` 里可显式指定 `hooksPath`（默认自动探测）：

```yaml
- insert:
    - id: hooks-panel
      name: 'dsh-hook'
      config:
        hooksPath: 'D:\my\dsh-home\hooks.json'
```

## 配套：让钩子真正生效

本插件只做**显示**。要让钩子在工具调用前真正拦截，需要装 DSH 官方的钩子桥：

- [`@deepseek-ai/dsh-hooks-claude-code`](https://www.npmjs.com/package/@deepseek-ai/dsh-hooks-claude-code)（选与内核版本一致的 tag）

配套的守卫脚本示例（拦截递归删除 / C 盘写入 / 环境变量枚举）见仓库 `examples/hook-guard.ps1`。

## 与其他插件的兼容性

- `@deepseek-ai/dsh` peer `>=0.2.0-rc.1`
- 客户端半依赖 `dsh-client-ui-slots` / `dsh-client-ui-renderer` / `dsh-client-connection`（DSH 内核自带）
- 与 `@linxin666/dsh-usage` 等 settings.section 插件共存（order 152，usage 之后）

## 架构

```
┌─ lib/index.js（宿主半）─────────────────────┐
│ 读 hooks.json（显式 hooksPath 或自动探测）    │
│ 注册 GET /api/dsh-hook/overview       │
└──────────────────────────────────────────────┘
              ↓ fetch（仅页面打开时 15s 轮询）
┌─ lib/client.js（客户端半）──────────────────┐
│ ctx.slots.register('settings.section', ...) │
│ 纯 DOM 渲染（React ref 挂载，无构建链）        │
└──────────────────────────────────────────────┘
```

> ⚠️ **构建说明（重要）**：本仓库目前**只提交编译产物** `lib/client.js`
> （文件头有 `//#region src/client/index.ts` 标记），**`src/` TypeScript 源码未纳入版本控制**。
> 因此 `lib/*.js` 是**唯一真源**，请直接编辑它们。
> 历史教训：v0.3.1 曾因「源码改了、产物没同步」导致 `relTime` 只有调用点而无定义，
> 使运行状态卡抛 `ReferenceError` 并拖垮整个面板（详见 `AUDIT.md`）。
> **建议后续把 `src/` 与构建脚本一并提交**，恢复可重建性。

## 测试

仓库内 `test/` 提供不依赖浏览器的验证脚本（Node 直接跑，无需安装依赖）：

```bash
node test/verify-cwrite.mjs     # cWrite 正则：只拦 C 盘、放行 D/E 盘与白名单
node test/verify-render.mjs     # 端到端渲染：用真实 client.js 渲染全部卡片，确保不抛异常
node test/verify-host.mjs       # 宿主半：路由返回含 ruleKeys，且与 zh/en 字典键一致
node test/verify-hardening.mjs  # 加固：loopback 校验、runs/clear 限 POST、字典键完备
```

## License

MIT
