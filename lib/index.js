/**
 * dsh-hook host half — reads the configured hooks.json (or auto-probes
 * the common locations) and exposes a loopback JSON route with the parsed hook
 * list (events, matchers, commands). No background work: the route reads on
 * demand. Route shape follows the dsh-webapp WebRoute contract:
 * { kind:'exact', path, handler(req, res) }.
 * @module dsh-hook
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export const name = 'dsh-hook'
export const inject = ['webServer']

const API_PATH = '/api/dsh-hook/overview'

/** Claude-code bridge supported events (same set as dsh-hooks-claude-code). */
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop']

/**
 * Auto-probe common hooks.json locations when no explicit hooksPath is set:
 * DSH home env (DSH_HOME), then the user-home conventions of Claude Code and
 * Codex CLI. Returns the first existing path, else null.
 */
function probeHooksPath() {
  const candidates = []
  const dshHome = process.env.DSH_HOME
  if (dshHome) candidates.push(join(dshHome, 'hooks.json'))
  const home = homedir()
  candidates.push(join(home, '.claude', 'hooks.json'))
  candidates.push(join(home, '.codex', 'hooks.json'))
  for (const p of candidates) {
    try { if (existsSync(p)) return p } catch {}
  }
  return null
}

/** Parse the claude-code event-to-matcher-group config into a flat hook list. */
function parseHooks(raw) {
  const hooks = []
  const root = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : undefined
  const map = root ? (typeof root.hooks === 'object' && root.hooks !== null ? root.hooks : root) : undefined
  if (!map) return hooks
  for (const event of EVENTS) {
    const groups = map[event]
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      if (typeof group !== 'object' || group === null || !Array.isArray(group.hooks)) continue
      const matcher = event === 'UserPromptSubmit' || event === 'Stop' ? undefined : (typeof group.matcher === 'string' ? group.matcher : undefined)
      for (const h of group.hooks) {
        if (typeof h !== 'object' || h === null || typeof h.command !== 'string') continue
        hooks.push({
          event,
          matcher: matcher ?? null,
          command: h.command,
          timeout: typeof h.timeout === 'number' ? h.timeout : null,
          statusMessage: typeof h.statusMessage === 'string' ? h.statusMessage : null,
          type: typeof h.type === 'string' ? h.type : 'command',
        })
      }
    }
  }
  return hooks
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export function apply(ctx, config) {
  /** Explicit config wins; else auto-probe once at mount (re-probed per request when null). */
  const explicitPath = typeof config?.hooksPath === 'string' && config.hooksPath.trim() !== '' ? config.hooksPath : undefined

  function resolvePath() {
    if (explicitPath) return explicitPath
    return probeHooksPath()
  }

  function buildDoc() {
    const hooksPath = resolvePath()
    let hooks = []
    let loadError = null
    if (hooksPath) {
      try {
        hooks = parseHooks(JSON.parse(readFileSync(hooksPath, 'utf8')))
      } catch (error) {
        loadError = String(error)
      }
    } else {
      loadError = '未找到 hooks.json：在插件配置里设置 hooksPath，或把 hooks.json 放到 ~/.claude/hooks.json / ~/.codex/hooks.json / $DSH_HOME/hooks.json'
    }
    return {
      hooksPath: hooksPath,
      loadError,
      total: hooks.length,
      hooks,
      generatedAt: Date.now(),
    }
  }

  try {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: API_PATH,
      handler: (req, res) => {
        writeJson(res, 200, buildDoc())
      },
    })
    ctx.effect(() => () => { try { dispose() } catch {} }, 'dsh-hook: route')
  } catch (error) {
    ctx.logger?.warn?.(`dsh-hook: route registration failed: ${String(error)}`)
  }
}
