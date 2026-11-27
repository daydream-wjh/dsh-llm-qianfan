/**
 * dsh-llm-qianfan — Token Plan usage readout, host half.
 *
 * Two readings, one card:
 *
 *  1. **Official quota** (`GET …/charge/tokenPlanPersonal/resource`). This is the
 *     only endpoint that answers "how much of the subscription is left", and it
 *     is a *console* endpoint: it authenticates with the logged-in
 *     console.bce.baidu.com session Cookie, not with the inference API key. A
 *     Token Plan key against it is answered with a 302 to the login page — that
 *     is the normal answer for a key, not a bug. The key and the Cookie are
 *     different credential classes and Baidu publishes no key-authenticated
 *     quota route: `/v2/tokenplan/personal/{usage,quota,plan,…}` all 404, and
 *     `chat/completions` returns token counts without any quota envelope.
 *
 *  2. **Local meter** (this process's own accounting). Every `usage` event the
 *     adapter emits is folded into per-window totals, so even with no Cookie the
 *     card can say what *this machine* spent on the plan in the last 5 hours, 7
 *     days and subscription month. It is a lower bound on the subscription's
 *     real consumption (the console counts every client), and it is labelled as
 *     such rather than passed off as the official number.
 *
 * The Cookie never leaves this process: the browser asks this route, the route
 * reads the credential store, and the store's `describe` view carries no value.
 *
 * Routes (both behind the host's own connection gate):
 *   GET  /qianfan-usage/usage            cached official reading + local meter
 *   GET  /qianfan-usage/usage?force=1    bypass the cache
 *   GET  /qianfan-usage/cookie           which ref is configured (never values)
 *   POST /qianfan-usage/cookie           { cookie } → store it
 *   DELETE /qianfan-usage/cookie         remove the stored value
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'

/** Browser-facing usage route. */
const USAGE_ROUTE = '/qianfan-usage/usage'

/** Browser-facing Cookie route. */
const COOKIE_ROUTE = '/qianfan-usage/cookie'

/**
 * The console endpoint that answers the Token Plan Personal subscription.
 *
 * Verified against the console's own front end: the Account page calls
 * `charge/tokenPlanPersonal/resource` through a wrapper that prefixes
 * `/api/qianfan` and sends the same-origin session Cookie plus
 * `X-Requested-With: XMLHttpRequest`. `billingMode: "credit"` fills
 * `usedCredits`/`totalCredits`, `"token"` fills `usedTokens`/`totalTokens`.
 */
export const QUOTA_URL = 'https://console.bce.baidu.com/api/qianfan/charge/tokenPlanPersonal/resource'

/** Credentials reference the console Cookie is stored under. */
const COOKIE_REF = 'BAIDU_QIANFAN_COOKIE'

/** A Cookie header longer than this is a paste accident, not a credential. */
const MAX_COOKIE_BYTES = 16384

/** Official reading freshness. The console itself is minute-scale. */
const QUOTA_CACHE_MS = 60_000

/** Upstream budget: the card re-polls, a hung request is worthless past this. */
const QUOTA_TIMEOUT_MS = 12_000

/**
 * The plan's own windows.
 *
 * Both are rolling, from the plan documentation: "额度由服务端按三段滚动窗口
 * 计算：5 小时、每周、每月" — the weekly window is a calendar-anchored 7 days,
 * the monthly one the subscription month. Baidu currently suspends the 5-hour
 * and 7-day sub-limits ("积分制存在每5小时和7天积分使用限制，当前限时取消"), so
 * the local meter reports them anyway: a suspended limit that comes back must
 * not need a plugin release to be visible.
 */
const WINDOW_MS = Object.freeze({
  fiveHour: 5 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
})

/* ------------------------------------------------------------------ *
 * Cookie shape (pure, exported for the offline harness)
 * ------------------------------------------------------------------ */

/**
 * Accept only a string that looks like a Cookie request header.
 *
 * Three shapes arrive in practice, and all three are supported because the
 * console's session cannot be read any other way:
 *
 *  1. A bare Cookie header (`BDUSS=…; bce-login-accountid=…`).
 *  2. The same header with a `Cookie:` prefix.
 *  3. A whole `Copy as cURL` command from DevTools. That is the only form a
 *     user can actually produce here: the session cookie is **HttpOnly**, so
 *     `document.cookie`, the DevTools *Application* panel's value cell, and any
 *     Cookie header visible to a page-side script all omit it. Right-click →
 *     "Copy as cURL" on the `tokenPlanPersonal/resource` request is the one
 *     gesture that carries it. Asking for a bare header would be asking for
 *     something the browser will not produce.
 *
 * A pasted inference API key is the common mistake, and it is refused here
 * rather than stored and then failing upstream with a 302 that reads like
 * "the quota endpoint is broken".
 * @param value - candidate Cookie header, prefixed header, or cURL command.
 * @returns the normalized Cookie header, or null when it is not one.
 */
export function normalizeCookie(value) {
  if (typeof value !== 'string') return null
  // Control characters are rejected, but a cURL command legitimately spans
  // lines: `\n` between `-H` flags is how DevTools formats it. Line breaks are
  // allowed through the shape check, then refused inside the header itself by
  // `normalizeCookieHeader` — a Cookie value is never multi-line.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return null
  if (value.length > MAX_COOKIE_BYTES) return null
  const text = value.trim()
  if (text === '') return null

  // A cURL command: pull out the cookie payload and nothing else. Quoting is
  // single- or double-stemmed and may contain `;` (which the shell quotes for
  // us), so the value is matched literally rather than split on separators.
  // DevTools emits the Cookie as `-H 'cookie: …'` on Windows/Linux and as
  // `-b '…'` / `--cookie '…'` on some platforms; all three are accepted.
  if (/^curl\b/i.test(text) || /\s(-H|--header|-b|--cookie)\s/.test(text)) {
    const header = /(?:-H|--header)\s+(['"])cookie:\s*([\s\S]*?)\1/i.exec(text)
    if (header !== null) return normalizeCookieHeader(header[2])
    const short = /(?:^|\s)(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/i.exec(text)
    if (short !== null) return normalizeCookieHeader(short[2])
    return null
  }
  if (text.toLowerCase().startsWith('cookie:')) return normalizeCookieHeader(text.slice(7))
  return normalizeCookieHeader(text)
}

/**
 * Validate one Cookie header and drop the parts a browser adds but no request
 * needs. Shared by every accepted input shape.
 * @param cookie - header text without its `Cookie:` prefix.
 * @returns the normalized header, or null.
 */
function normalizeCookieHeader(cookie) {
  if (typeof cookie !== 'string') return null
  const trimmed = cookie.trim()
  if (trimmed === '' || /[\r\n]/.test(trimmed)) return null
  const parts = trimmed.split(';').filter((part) => part.trim() !== '')
  if (parts.length === 0) return null
  // Every part must be `name=value`. A value may itself contain `=` (base64
  // padding, JWT fragments), so the split is on the first `=` only.
  const shaped = parts.every((part) => /^\s*[^=\s;]+=[^;]*$/.test(part))
  if (!shaped) return null
  // `BDUSS` is the session itself. Without it every other console cookie is
  // decoration and the request lands on the login page, so a header that lacks
  // it is rejected at save time instead of stored as a permanently failing
  // credential. `bce-passport-stoken` alone is not a substitute: measured, it
  // answers 302 on its own.
  const names = parts.map((part) => part.split('=')[0].trim())
  if (!names.includes('BDUSS')) return null
  return parts.map((part) => part.trim()).join('; ')
}

/* ------------------------------------------------------------------ *
 * Official reading (pure, exported for the offline harness)
 * ------------------------------------------------------------------ */

/** A non-negative finite number from a JSON number or numeric string. */
function amountOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
  }
  return null
}

/**
 * Parse an `expiresAt` the console emits.
 *
 * The console writes China wall-clock time without a zone
 * (`2026-12-01 10:00:00`). Reading that with `new Date()` would apply the host
 * zone — a Mac set to UTC+8 happens to agree, a laptop travelling does not — so
 * a zone-less value is pinned to +08:00 explicitly.
 * @param value - timestamp from the console payload.
 * @returns epoch milliseconds, or null.
 */
export function expiryOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const text = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value.trim())
    ? `${value.trim().replace(' ', 'T')}+08:00`
    : value.trim()
  const at = Date.parse(text)
  return Number.isNaN(at) ? null : at
}

/**
 * Narrow the console payload to the card's shape.
 *
 * The console answers `{ success, result: { items: [...] } }` and lists plans a
 * user has held; only the live one describes the current quota. "Live" means
 * not `Released` and not already expired — an expired row still being listed is
 * the normal state after a lapse, and showing its 100% used bar would read as a
 * budget problem rather than a lapsed subscription.
 * @param payload - decoded console body.
 * @param now - clock used to decide whether a row is live.
 * @returns `{ ok: true, plan }` or `{ ok: false, code, message }`.
 */
export function parseQuota(payload, now = Date.now()) {
  if (payload === null || typeof payload !== 'object') {
    return { ok: false, code: 'payload', message: '控制台返回的不是 JSON 对象' }
  }
  if (payload.success !== true) {
    const hinted = payload.message?.global ?? payload.message ?? payload.code
    return {
      ok: false,
      code: 'console',
      message: typeof hinted === 'string' ? `控制台拒绝查询：${hinted}` : '控制台没有返回成功信封',
    }
  }
  const items = payload.result?.items
  if (!Array.isArray(items)) {
    return { ok: false, code: 'payload', message: '控制台返回里没有套餐列表' }
  }
  const live = items.find((row) => {
    if (row === null || typeof row !== 'object') return false
    if (row.resourceStatus === 'Released') return false
    const expiry = expiryOf(row.expiresAt)
    return expiry === null ? true : expiry > now
  })
  if (live === undefined) {
    return { ok: false, code: 'no-plan', message: '没有有效的 Token Plan 个人版套餐' }
  }

  const billingMode = live.billingMode === 'credit' ? 'credit' : 'token'
  const used = amountOf(billingMode === 'credit' ? live.usedCredits : live.usedTokens)
  const total = amountOf(billingMode === 'credit' ? live.totalCredits : live.totalTokens)
  if (used === null || total === null || total <= 0) {
    return { ok: false, code: 'payload', message: '套餐额度字段不完整' }
  }
  return {
    ok: true,
    plan: {
      planKey: typeof live.planType === 'string' ? live.planType.toLowerCase() : null,
      billingMode,
      unit: billingMode === 'credit' ? 'credits' : 'tokens',
      used,
      total,
      remaining: Math.max(0, total - used),
      percent: Math.max(0, Math.min(100, (used / total) * 100)),
      expiresAt: expiryOf(live.expiresAt),
      autoRenew: live.autoRenew === true,
      // The console row carries an `apiKey` field. It is never forwarded: it is
      // the subscription's secret, and no part of this card needs it.
    },
  }
}

/**
 * Read the official quota once.
 *
 * Split out of `apply` so the offline harness can drive it with a stub
 * `fetchImpl`: what needs testing is the mapping, not the network.
 * @param options.cookie - console session Cookie header.
 * @param options.fetchImpl - `fetch`-compatible function.
 * @param options.timeoutMs - upstream budget.
 * @returns a body carrying `ok` first, never an HTTP error for a soft failure.
 */
export async function readQuota({ cookie, fetchImpl = fetch, timeoutMs = QUOTA_TIMEOUT_MS }) {
  let response
  try {
    response = await fetchImpl(QUOTA_URL, {
      method: 'GET',
      // `redirect: 'manual'` is the whole point: an expired session answers 302
      // to the login page, and following it would fetch HTML that this parser
      // would then report as a payload problem — hiding "log in again" behind
      // "the response is not JSON".
      redirect: 'manual',
      headers: {
        cookie,
        accept: 'application/json',
        'x-requested-with': 'XMLHttpRequest',
        'user-agent': 'dsh-llm-qianfan/usage-readout',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const timeout = error !== null && typeof error === 'object' && error.name === 'TimeoutError'
    return {
      ok: false,
      code: timeout ? 'timeout' : 'network',
      message: timeout ? '读取千帆控制台超时' : `连接 console.bce.baidu.com 失败：${error?.message ?? error}`,
    }
  }

  if (response.status >= 300 && response.status < 400) {
    return { ok: false, code: 'login', message: '控制台登录已过期，请重新复制 Cookie', status: response.status }
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, code: 'login', message: '控制台拒绝了这个 Cookie', status: response.status }
  }
  if (!response.ok) {
    return { ok: false, code: 'upstream', message: `控制台返回 HTTP ${response.status}`, status: response.status }
  }

  let payload
  try {
    payload = await response.json()
  } catch {
    return { ok: false, code: 'payload', message: '控制台返回的不是 JSON' }
  }
  // A session that expired between the status line and the body still reports
  // the redirect in the envelope on some console paths.
  if (payload?.message?.redirect !== undefined || ['401', '403'].includes(String(payload?.code))) {
    return { ok: false, code: 'login', message: '控制台登录已过期，请重新复制 Cookie' }
  }
  return parseQuota(payload)
}

/* ------------------------------------------------------------------ *
 * Local meter (pure, exported for the offline harness)
 * ------------------------------------------------------------------ */

/**
 * Fold one adapter `usage` report into the plan windows.
 *
 * Qianfan bills cached prompt tokens like any other prompt token in the Token
 * mode ("不区分输入、输出及缓存 Token"), so the meter's unit is
 * `inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens` — the same
 * sum the vendor describes, and *not* the harness's disjoint triple by itself.
 * @param state - previous meter state, or null for a fresh one.
 * @param usage - adapter usage block, already in harness vocabulary.
 * @param at - epoch milliseconds of the report.
 * @returns a new meter state (never mutates the argument).
 */
export function foldUsage(state, usage, at = Date.now()) {
  const base = state !== null && typeof state === 'object' ? state : {}
  const samples = Array.isArray(base.samples) ? base.samples : []
  const input = amountOf(usage?.inputTokens) ?? 0
  const cacheRead = amountOf(usage?.cacheReadTokens) ?? 0
  const cacheWrite = amountOf(usage?.cacheWriteTokens) ?? 0
  const output = amountOf(usage?.outputTokens) ?? 0
  const billed = input + cacheRead + cacheWrite + output
  if (billed <= 0) return base
  const next = samples.concat([{ at, input, cacheRead, cacheWrite, output, billed }])
  return { samples: pruneSamples(next, at) }
}

/**
 * Drop samples that no window can still see.
 *
 * Without this the array grows for the life of the process. The longest window
 * is the month, so anything older is unreachable state.
 * @param samples - accumulated samples, oldest first.
 * @param now - epoch milliseconds.
 * @returns the retained tail.
 */
export function pruneSamples(samples, now = Date.now()) {
  const horizon = now - WINDOW_MS.month
  let cut = 0
  while (cut < samples.length && samples[cut].at < horizon) cut += 1
  return cut === 0 ? samples : samples.slice(cut)
}

/**
 * Sum the meter over one window.
 * @param samples - accumulated samples.
 * @param windowMs - window length.
 * @param now - epoch milliseconds.
 * @returns `{ billed, input, cacheRead, cacheWrite, output, requests }`.
 */
export function sumWindow(samples, windowMs, now = Date.now()) {
  const since = now - windowMs
  const total = { billed: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0 }
  for (const sample of samples) {
    if (sample.at < since) continue
    total.billed += sample.billed
    total.input += sample.input
    total.cacheRead += sample.cacheRead
    total.cacheWrite += sample.cacheWrite
    total.output += sample.output
    total.requests += 1
  }
  return total
}

/**
 * The card's local-meter section.
 * @param state - meter state as stored on the plugin.
 * @param now - epoch milliseconds.
 * @returns `{ windows, requests }`, always present even when empty.
 */
export function meterView(state, now = Date.now()) {
  const samples = Array.isArray(state?.samples) ? pruneSamples(state.samples, now) : []
  return {
    windows: {
      fiveHour: sumWindow(samples, WINDOW_MS.fiveHour, now),
      week: sumWindow(samples, WINDOW_MS.week, now),
      month: sumWindow(samples, WINDOW_MS.month, now),
    },
    lastAt: samples.length === 0 ? null : samples[samples.length - 1].at,
  }
}

/* ------------------------------------------------------------------ *
 * Route plumbing
 * ------------------------------------------------------------------ */

/** JSON response, never cached by the browser. */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * Read one bounded JSON body.
 *
 * The Cookie write is only reachable from an authenticated same-origin page;
 * this is the local fence: a body that declares or streams past the limit is
 * refused before it is all in memory.
 * @param req - incoming request.
 * @param limit - byte ceiling.
 * @returns the decoded body.
 */
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers?.['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      reject(new Error(`请求体超过 ${limit} 字节`))
      return
    }
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`请求体超过 ${limit} 字节`))
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', (error) => reject(error))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是 JSON'))
      }
    })
  })
}

/**
 * Read the console Cookie from, in order: the row config, the launch
 * environment, then the credentials file.
 *
 * Mirrors how the provider route resolves its API key — a user who configured
 * one should not have to learn a second convention for the other.
 * @param config - row config.
 * @returns the Cookie header, or null.
 */
export function resolveCookie(config) {
  const candidates = []
  if (typeof config?.cookie === 'string' && config.cookie.trim() !== '') candidates.push(config.cookie.trim())
  const fromEnv = process.env[COOKIE_REF]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') candidates.push(fromEnv.trim())
  const file = typeof config?.credentialsFile === 'string' && config.credentialsFile !== ''
    ? config.credentialsFile
    : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml')
  try {
    const text = readFileSync(file, 'utf8')
    const refs = parseRefs(text)
    const stored = refs.get(COOKIE_REF)
    if (stored !== undefined && stored.trim() !== '') candidates.push(stored.trim())
  } catch {
    // No readable store is not an error here: the card simply reports that no
    // Cookie is configured and falls back to the local meter.
  }
  return normalizeCookie(candidates[0] ?? '') ?? null
}

/**
 * Split a credentials YAML `refs` block into key/value pairs.
 *
 * Same layout the provider route reads: two-space indent, one `KEY: value` per
 * line, value optionally quoted. Kept local so this module has no import cycle
 * with `index.js`.
 * @param text - raw credentials file contents.
 * @returns resolved refs, values unquoted.
 */
export function parseRefs(text) {
  const refs = new Map()
  let inRefs = false
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) {
      inRefs = line.startsWith('refs:')
      continue
    }
    if (!inRefs) continue
    const match = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line)
    if (match === null) continue
    let value = match[2].trim()
    if (value.length >= 2 && (value.startsWith("'") || value.startsWith('"'))) value = value.slice(1, -1)
    if (value.length > 0) refs.set(match[1], value)
  }
  return refs
}

/**
 * Mount the usage + Cookie routes.
 *
 * @param ctx - plugin context; `webServer` is required, `connection` is used for
 *   the request gate when the profile has it.
 * @param options - `{ configOf, meterOf, credentialsOf }`:
 *   `configOf` reads the live row config (so a Cookie saved through the UI is
 *   picked up without a reload), `meterOf` reads the adapter's meter state, and
 *   `credentialsOf` returns the credential store from a context that declares
 *   it — reading a service from a context that never injected it throws, and a
 *   thrown read here would turn every Cookie write into "no store".
 */
export function mountUsageRoutes(ctx, options) {
  const { configOf, meterOf } = options

  let cached = null
  let inflight = null

  /** The host's own request gate, whichever generation of it this build has. */
  const rejected = (req) => {
    const connection = ctx.get?.('connection')
    if (connection === undefined) return undefined
    if (typeof connection.requestRejection === 'function') return connection.requestRejection(req)
    if (typeof connection.admit === 'function') {
      const answer = connection.admit({ method: req.method, url: req.url, headers: req.headers, remoteAddress: req.socket?.remoteAddress })
      return typeof answer?.rejection === 'number' ? answer.rejection : answer === undefined ? 403 : undefined
    }
    return undefined
  }

  /** The credential store, resolved through the caller's accessor. */
  const storeOf = () => {
    try {
      return options.credentialsOf?.() ?? ctx.get?.('credentials')
    } catch {
      return undefined
    }
  }

  const readQuotaShared = (cookie) => {
    if (inflight !== null) return inflight
    const pending = readQuota({ cookie }).finally(() => {
      inflight = null
    })
    inflight = pending
    return pending
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: USAGE_ROUTE,
        handler: async (req, res) => {
          const rejection = rejected(req)
          if (rejection !== undefined) {
            res.statusCode = rejection
            res.end()
            return
          }
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.statusCode = 405
            res.setHeader('allow', 'GET, HEAD')
            res.end()
            return
          }

          const params = new URL(String(req.url), 'http://localhost').searchParams
          const force = params.get('force') === '1'
          const meter = meterView(meterOf())

          if (!force && cached !== null && Date.now() - cached.at < QUOTA_CACHE_MS) {
            sendJson(res, 200, { ...cached.body, meter, cached: true, fetchedAt: new Date(cached.at).toISOString() })
            return
          }

          const cookie = resolveCookie(configOf())
          if (cookie === null) {
            // Not a failure: the local meter is still a real reading, and the
            // card shows it while saying the official number needs a Cookie.
            sendJson(res, 200, {
              ok: false,
              code: 'no-cookie',
              message: `未配置千帆控制台 Cookie（凭据名 ${COOKIE_REF}）；推理 API Key 不能查询套餐额度`,
              meter,
              fetchedAt: new Date().toISOString(),
            })
            return
          }

          const answer = await readQuotaShared(cookie)
          const body = { ...answer, meter }
          // Only a real reading is cached: a transient failure must not pin the
          // card to an error for the whole TTL.
          cached = answer.ok ? { at: Date.now(), body } : null
          sendJson(res, 200, { ...body, fetchedAt: new Date().toISOString() })
        },
      }),
    `llm-qianfan: GET ${USAGE_ROUTE}`,
  )

  /** Describe the Cookie ref so the settings page can say what is configured. */
  const statusOf = async () => {
    const credentials = storeOf()
    let info = null
    if (credentials !== undefined) {
      try {
        info = await credentials.describe(COOKIE_REF)
      } catch {
        info = null
      }
    }
    const resolved = resolveCookie(configOf())
    return {
      ok: true,
      ref: COOKIE_REF,
      configured: info?.configured === true || resolved !== null,
      source: typeof info?.source === 'string' ? info.source : resolved === null ? null : 'config',
      masked: typeof info?.masked === 'string' ? info.masked : null,
      writable: info?.writable === true,
      raw: resolved !== null,
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: COOKIE_ROUTE,
        handler: async (req, res) => {
          const rejection = rejected(req)
          if (rejection !== undefined) {
            res.statusCode = rejection
            res.end()
            return
          }

          if (req.method === 'GET' || req.method === 'HEAD') {
            sendJson(res, 200, await statusOf())
            return
          }

          const credentials = storeOf()
          if (credentials === undefined) {
            sendJson(res, 200, {
              ok: false,
              code: 'no-store',
              message: '这个 profile 没有凭据存储，Cookie 无法保存；可改用环境变量 BAIDU_QIANFAN_COOKIE',
            })
            return
          }

          if (req.method === 'DELETE') {
            let error = null
            try {
              await credentials.unset(COOKIE_REF)
            } catch (failure) {
              error = failure
            }
            if (error !== null) {
              sendJson(res, 200, { ok: false, code: 'refused', message: `凭据库拒绝删除：${error?.message ?? error}` })
              return
            }
            cached = null
            sendJson(res, 200, { ...(await statusOf()), cleared: true })
            return
          }

          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'GET, HEAD, POST, DELETE')
            res.end()
            return
          }

          let payload
          try {
            payload = await readJsonBody(req, MAX_COOKIE_BYTES)
          } catch (failure) {
            sendJson(res, 200, { ok: false, code: 'body', message: String(failure?.message ?? failure) })
            return
          }
          const raw = typeof payload?.cookie === 'string' ? payload.cookie : ''
          if (raw.trim() === '') {
            sendJson(res, 200, { ok: false, code: 'empty', message: 'Cookie 不能为空' })
            return
          }
          const cookie = normalizeCookie(raw)
          if (cookie === null) {
            // Three failures are worth telling apart, because each has a
            // different fix and the wrong message sends the user down the wrong
            // path: an inference key, a header missing the HttpOnly session, and
            // text that is not a Cookie at all.
            const looksLikeKey = /^bce-v3\/|^sk-/.test(raw.trim())
            const looksLikeCookie = /=/.test(raw)
            sendJson(res, 200, {
              ok: false,
              code: looksLikeKey ? 'api-key' : 'shape',
              message: looksLikeKey
                ? '这看起来是推理 API Key，不是控制台 Cookie；额度查询只认 console.bce.baidu.com 的登录 Cookie'
                : looksLikeCookie
                  ? '这段 Cookie 里没有 BDUSS —— 它是 HttpOnly 的，`document.cookie` 和应用面板都读不到。'
                    + '请在控制台的「网络」面板里右键 tokenPlanPersonal/resource 请求 →「Copy as cURL」，把整段命令粘进来。'
                  : '这段内容不像 Cookie。请在控制台「网络」面板右键 tokenPlanPersonal/resource →「Copy as cURL」，整段粘进来即可。',
            })
            return
          }

          // Probe before saving: storing a Cookie that cannot read the quota
          // would leave the card showing "configured" beside a login error with
          // no way to tell which of the two is wrong.
          const probe = await readQuota({ cookie })
          if (probe.ok === false && probe.code === 'login') {
            sendJson(res, 200, { ok: false, code: 'login', message: probe.message })
            return
          }

          let error = null
          try {
            await credentials.set(COOKIE_REF, cookie)
          } catch (failure) {
            error = failure
          }
          if (error !== null) {
            sendJson(res, 200, { ok: false, code: 'refused', message: `凭据库拒绝写入：${error?.message ?? error}` })
            return
          }
          cached = null
          const saved = await statusOf()
          sendJson(res, 200, {
            ...saved,
            saved: true,
            // A Cookie that stores fine but cannot read the quota is still worth
            // saving — the login may simply have expired a second ago — so the
            // probe's verdict is reported beside the save, not instead of it.
            probe: probe.ok === true ? { ok: true } : { ok: false, code: probe.code, message: probe.message },
          })
        },
      }),
    `llm-qianfan: ${COOKIE_ROUTE}`,
  )
}