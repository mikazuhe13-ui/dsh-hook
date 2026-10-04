/**
 * dsh-hook host half — reads the configured hooks.json (or auto-probes the
 * common locations) and exposes loopback JSON routes:
 *   GET  /api/dsh-hook/overview — parsed hook list (events, matchers, commands)
 *   GET  /api/dsh-hook/rules    — per-rule switches (hooks-rules.json)
 *   POST /api/dsh-hook/rules    — write per-rule switches (real-time effect)
 * No background work: routes read/write on demand.
 * Route shape follows the dsh-webapp WebRoute contract:
 * { kind:'exact', path, handler(req, res) }.
 * @module dsh-hook
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export const name = 'dsh-hook'
export const inject = ['webServer']

const API_OVERVIEW = '/api/dsh-hook/overview'
const API_RULES = '/api/dsh-hook/rules'
const API_RUNS_CLEAR = '/api/dsh-hook/runs/clear'

/** Claude-code bridge supported events (same set as dsh-hooks-claude-code). */
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop']

/** Rule keys with labels (the panel renders these). */
const RULE_KEYS = [
  { key: 'recursion', label: '递归删除保护', desc: '拦截 Remove-Item -Recurse 触及 node_modules/profiles/skills' },
  { key: 'cWrite', label: 'C 盘写入保护', desc: '拦截 write/edit 写 C 盘非白名单路径' },
  { key: 'envProbe', label: '环境变量枚举拦截', desc: '拦截 Get-ChildItem Env:（结果不可信）' },
  { key: 'bskJunction', label: '.bsk Junction 保护', desc: '拦截 .bsk junction 上的 -Recurse' },
]

function rulesPath() {
  const dshHome = process.env.DSH_HOME
  if (dshHome) return join(dshHome, 'hooks-rules.json')
  return join(homedir(), '.dsh-hook', 'rules.json')
}

/** Auto-probe common hooks.json locations when no explicit hooksPath is set. */
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

function readJsonNoBom(path) {
  let text = readFileSync(path, 'utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return JSON.parse(text)
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export function apply(ctx, config) {
  const explicitPath = typeof config?.hooksPath === 'string' && config.hooksPath.trim() !== '' ? config.hooksPath : undefined

  function resolvePath() {
    if (explicitPath) return explicitPath
    return probeHooksPath()
  }

  function readRules() {
    const p = rulesPath()
    try {
      if (!existsSync(p)) return {}
      const parsed = readJsonNoBom(p) ?? {}
      // 临时关闭已到期 → 清除 expiresAt 并恢复 true（持久化回去，下次读不再处理）
      let dirty = false
      for (const key of Object.keys(parsed)) {
        const v = parsed[key]
        if (v && typeof v === 'object' && v.until) {
          if (Date.now() >= v.until) {
            parsed[key] = true
            dirty = true
          } else {
            parsed[key] = false // 临时关闭期内
          }
        }
      }
      if (dirty) writeRules(parsed)
      return parsed
    } catch { return {} }
  }

  function writeRules(rules) {
    const p = rulesPath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(rules, null, 2), 'utf8')
  }

  function buildDoc() {
    const hooksPath = resolvePath()
    let hooks = []
    let loadError = null
    if (hooksPath) {
      try {
        hooks = parseHooks(readJsonNoBom(hooksPath))
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
      rules: readRules(),
      rulesPath: rulesPath(),
      runs: readRuns(),
      generatedAt: Date.now(),
    }
  }

  /** 运行统计：hook-guard.mjs 每次调用写入的 hooks-runs.json（最近 20 条） */
  function runsFile() {
    const dshHome = process.env.DSH_HOME
    if (dshHome) return join(dshHome, 'hooks-runs.json')
    return join(homedir(), '.dsh-hook', 'hooks-runs.json')
  }

  function readRuns() {
    try {
      const p = runsFile()
      if (!existsSync(p)) return []
      return readJsonNoBom(p)?.runs ?? []
    } catch { return [] }
  }

  function isLoopback(req) {
    const addr = req.socket?.remoteAddress ?? ''
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', (c) => { body += c; if (body.length > 64 * 1024) { reject(new Error('body too large')); req.destroy() } })
      req.on('end', () => resolve(body))
      req.on('error', reject)
    })
  }

  try {
    const disposeOverview = ctx.webServer.register({
      kind: 'exact',
      path: API_OVERVIEW,
      handler: (req, res) => {
        writeJson(res, 200, buildDoc())
      },
    })
    const disposeRules = ctx.webServer.register({
      kind: 'exact',
      path: API_RULES,
      handler: (req, res) => {
        if (req.method === 'GET' || req.method === undefined) {
          writeJson(res, 200, { rules: readRules(), rulesPath: rulesPath(), keys: RULE_KEYS })
          return
        }
        if (req.method === 'POST') {
          if (!isLoopback(req)) { writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' }); return }
          readBody(req).then((body) => {
            try {
              const incoming = JSON.parse(body)
              const current = readRules()
              for (const { key } of RULE_KEYS) {
                // { rule: true/false } 永久开关；{ rule: { minutes: N } } 临时关闭 N 分钟
                const v = incoming[key]
                if (v === true) current[key] = true
                else if (v === false) current[key] = false
                else if (v && typeof v === 'object' && typeof v.minutes === 'number' && v.minutes > 0 && v.minutes <= 1440) {
                  current[key] = { until: Date.now() + v.minutes * 60_000 }
                }
              }
              writeRules(current)
              writeJson(res, 200, { ok: true, rules: readRules() })
            } catch (error) {
              writeJson(res, 400, { ok: false, error: String(error) })
            }
          }, (error) => writeJson(res, 400, { ok: false, error: String(error) }))
          return
        }
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
      },
    })
    const disposeRunsClear = ctx.webServer.register({
      kind: 'exact',
      path: API_RUNS_CLEAR,
      handler: (req, res) => {
        if (!isLoopback(req)) { writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' }); return }
        try {
          const p = runsFile()
          if (existsSync(p)) unlinkSync(p)
          writeJson(res, 200, { ok: true })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error) })
        }
      },
    })
    ctx.effect(() => () => { try { disposeOverview() } catch {} try { disposeRules() } catch {} try { disposeRunsClear() } catch {} }, 'dsh-hook: routes')
  } catch (error) {
    ctx.logger?.warn?.(`dsh-hook: route registration failed: ${String(error)}`)
  }
}
