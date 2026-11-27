/**
 * Offline harness for dsh-llm-qianfan/lib/usage-meter.js.
 *
 * Drives the real module with stub `fetch` implementations and synthetic
 * samples. What it proves is the mapping and the window arithmetic — the two
 * places a wrong reading hides behind a correct-looking card. It cannot prove
 * what a real console answers, because no account is involved.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  expiryOf,
  foldUsage,
  meterView,
  normalizeCookie,
  parseQuota,
  parseRefs,
  pruneSamples,
  readQuota,
  sumWindow,
} from '../lib/usage-meter.js'

/** A console body shaped the way the console's own front end reads it. */
function consoleBody(overrides = {}) {
  return {
    success: true,
    result: {
      items: [
        {
          resourceId: 'res-1',
          planType: 'PRO',
          billingMode: 'credit',
          usedCredits: 18450,
          totalCredits: 45000,
          resourceStatus: 'Running',
          expiresAt: '2026-12-27 10:00:00',
          autoRenew: true,
          // The console row carries the subscription's secret; nothing may
          // forward it.
          apiKey: 'bce-v3/ALTAK-secret-never-forwarded',
          ...overrides,
        },
      ],
    },
  }
}

test('cookie: accepts a bare header that carries the session', () => {
  assert.equal(
    normalizeCookie('BDUSS=abc:FG=1; bce-login-accountid=xyz'),
    'BDUSS=abc:FG=1; bce-login-accountid=xyz',
  )
  assert.equal(normalizeCookie('Cookie: BDUSS=abc'), 'BDUSS=abc')
  // Padding and embedded `=` in the value survive: split is on the first `=`.
  assert.equal(normalizeCookie('  BDUSS=ab== ; b=2 '), 'BDUSS=ab==; b=2')
})

test('cookie: refuses a header without BDUSS, because it cannot authenticate', () => {
  // Measured: with every non-HttpOnly console cookie present and BDUSS absent,
  // the quota endpoint answers 302 to the login page. Storing this would mean a
  // credential that reads as configured and always fails.
  assert.equal(normalizeCookie('BAIDUID=abc; bce-passport-stoken=def'), null)
  assert.equal(normalizeCookie('bce-login-accountid=1caf; bce-user-info="x|y"'), null)
})

test('cookie: accepts a DevTools Copy-as-cURL command', () => {
  const command = [
    "curl 'https://console.bce.baidu.com/api/qianfan/charge/tokenPlanPersonal/resource' \\",
    "  -H 'accept: application/json' \\",
    "  -H 'cookie: BDUSS=abc123; BAIDUID=def:FG=1; bce-login-accountid=1caf' \\",
    "  -H 'x-requested-with: XMLHttpRequest'",
  ].join('\n')
  assert.equal(normalizeCookie(command), 'BDUSS=abc123; BAIDUID=def:FG=1; bce-login-accountid=1caf')
})

test('cookie: accepts the -b form and double quotes', () => {
  assert.equal(
    normalizeCookie('curl "https://x/" -b "BDUSS=a; b=2"'),
    'BDUSS=a; b=2',
  )
  assert.equal(
    normalizeCookie("curl 'https://x/' --cookie 'BDUSS=a'"),
    'BDUSS=a',
  )
})

test('cookie: a cURL command without BDUSS is still refused', () => {
  assert.equal(normalizeCookie("curl 'https://x/' -H 'cookie: BAIDUID=only'"), null)
})

test('cookie: refuses shapes that are not a Cookie at all', () => {
  assert.equal(normalizeCookie('bce-v3/ALTAK-abc'), null)
  assert.equal(normalizeCookie('BDUSS=abc\nInjected: 1'), null)
  assert.equal(normalizeCookie(''), null)
  assert.equal(normalizeCookie(undefined), null)
  assert.equal(normalizeCookie('no-equals-sign'), null)
  assert.equal(normalizeCookie('BDUSS=' + 'a'.repeat(20000)), null)
})

test('expiry: a zone-less console timestamp is China time, not the host zone', () => {
  // 2026-12-27 10:00:00 +08:00 == 02:00:00Z
  assert.equal(expiryOf('2026-12-27 10:00:00'), Date.parse('2026-12-27T02:00:00Z'))
  // An explicit zone is honoured verbatim.
  assert.equal(expiryOf('2026-12-27T02:00:00Z'), Date.parse('2026-12-27T02:00:00Z'))
  assert.equal(expiryOf(''), null)
  assert.equal(expiryOf('not a date'), null)
})

test('quota: credit-mode plan maps to used/total/percent', () => {
  const now = Date.parse('2026-11-27T00:00:00Z')
  const answer = parseQuota(consoleBody(), now)
  assert.equal(answer.ok, true)
  assert.equal(answer.plan.billingMode, 'credit')
  assert.equal(answer.plan.unit, 'credits')
  assert.equal(answer.plan.used, 18450)
  assert.equal(answer.plan.total, 45000)
  assert.equal(answer.plan.remaining, 26550)
  assert.equal(Math.round(answer.plan.percent * 100) / 100, 41)
  assert.equal(answer.plan.expiresAt, expiryOf('2026-12-27 10:00:00'))
  assert.equal(answer.plan.autoRenew, true)
  assert.equal('apiKey' in answer.plan, false, 'the plan secret must not be forwarded')
  assert.equal(JSON.stringify(answer).includes('ALTAK'), false, 'no key material may leak')
})

test('quota: token-mode plan reads the token fields, not the credit ones', () => {
  const answer = parseQuota(consoleBody({
    billingMode: 'token',
    usedTokens: '2300000',
    totalTokens: 230000000,
    usedCredits: 0,
    totalCredits: 0,
  }), Date.parse('2026-11-27T00:00:00Z'))
  assert.equal(answer.ok, true)
  assert.equal(answer.plan.billingMode, 'token')
  assert.equal(answer.plan.unit, 'tokens')
  assert.equal(answer.plan.used, 2300000)
  assert.equal(answer.plan.total, 230000000)
})

test('quota: a released row is skipped in favour of the live one', () => {
  const payload = consoleBody()
  payload.result.items.unshift({
    billingMode: 'credit',
    usedCredits: 1,
    totalCredits: 1,
    resourceStatus: 'Released',
    expiresAt: '2026-12-27 10:00:00',
  })
  const answer = parseQuota(payload, Date.parse('2026-11-27T00:00:00Z'))
  assert.equal(answer.ok, true)
  assert.equal(answer.plan.used, 18450)
})

test('quota: an expired-only listing is a lapsed plan, not a spent one', () => {
  const answer = parseQuota(
    consoleBody({ expiresAt: '2026-01-01 00:00:00' }),
    Date.parse('2026-11-27T00:00:00Z'),
  )
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'no-plan')
})

test('quota: unusable payloads report their own cause', () => {
  assert.equal(parseQuota(null).code, 'payload')
  assert.equal(parseQuota({ success: false, message: { global: '未登录' } }).code, 'console')
  assert.equal(parseQuota({ success: true, result: {} }).code, 'payload')
  assert.equal(parseQuota(consoleBody({ totalCredits: 0 })).code, 'payload')
  assert.equal(parseQuota(consoleBody({ usedCredits: -1 })).code, 'payload')
})

test('readQuota: a session redirect is a login problem, not a payload problem', async () => {
  const answer = await readQuota({
    cookie: 'a=1',
    fetchImpl: async () => ({ ok: false, status: 302, headers: new Map() }),
  })
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'login')
})

test('readQuota: 401/403 are a refused Cookie', async () => {
  for (const status of [401, 403]) {
    const answer = await readQuota({ cookie: 'a=1', fetchImpl: async () => ({ ok: false, status, headers: new Map() }) })
    assert.equal(answer.code, 'login')
  }
})

test('readQuota: a redirect reported in the envelope is also a login problem', async () => {
  const answer = await readQuota({
    cookie: 'a=1',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({ success: false, message: { redirect: 'https://login.bce.baidu.com/' } }),
    }),
  })
  assert.equal(answer.code, 'login')
})

test('readQuota: a timeout is named as one', async () => {
  const answer = await readQuota({
    cookie: 'a=1',
    fetchImpl: async () => {
      const error = new Error('timed out')
      error.name = 'TimeoutError'
      throw error
    },
  })
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'timeout')
})

test('readQuota: sends the console headers and refuses to follow redirects', async () => {
  let seen = null
  await readQuota({
    cookie: 'BAIDUID=abc',
    fetchImpl: async (url, init) => {
      seen = { url, init }
      return { ok: true, status: 200, headers: new Map(), json: async () => consoleBody() }
    },
  })
  assert.equal(seen.url, 'https://console.bce.baidu.com/api/qianfan/charge/tokenPlanPersonal/resource')
  assert.equal(seen.init.redirect, 'manual')
  assert.equal(seen.init.headers.cookie, 'BAIDUID=abc')
  assert.equal(seen.init.headers['x-requested-with'], 'XMLHttpRequest')
})

test('meter: a usage report folds into token-mode billed total including cache', () => {
  const at = 1_000_000
  const state = foldUsage(null, { inputTokens: 100, outputTokens: 40, cacheReadTokens: 900, cacheWriteTokens: 20 }, at)
  assert.equal(state.samples.length, 1)
  // Qianfan bills cached prompt tokens too, so all four buckets count.
  assert.equal(state.samples[0].billed, 1060)
  assert.equal(state.samples[0].input, 100)
  assert.equal(state.samples[0].cacheRead, 900)
})

test('meter: a report with nothing billable is dropped, not stored as zero', () => {
  const state = foldUsage(null, { inputTokens: 0, outputTokens: 0 }, 1)
  assert.equal(Array.isArray(state.samples) ? state.samples.length : 0, 0)
})

test('meter: folding never mutates the previous state', () => {
  const first = foldUsage(null, { inputTokens: 10, outputTokens: 10 }, 1_000)
  const before = JSON.stringify(first)
  const second = foldUsage(first, { inputTokens: 5, outputTokens: 5 }, 2_000)
  assert.equal(JSON.stringify(first), before)
  assert.equal(second.samples.length, 2)
})

test('meter: windows separate by age', () => {
  const now = 10 * 24 * 60 * 60 * 1000
  let state = null
  state = foldUsage(state, { inputTokens: 100, outputTokens: 100 }, now - 4 * 60 * 60 * 1000) // inside 5h
  state = foldUsage(state, { inputTokens: 200, outputTokens: 200 }, now - 3 * 24 * 60 * 60 * 1000) // inside week
  state = foldUsage(state, { inputTokens: 400, outputTokens: 400 }, now - 20 * 24 * 60 * 60 * 1000) // inside month
  state = foldUsage(state, { inputTokens: 800, outputTokens: 800 }, now - 40 * 24 * 60 * 60 * 1000) // outside every window

  const view = meterView(state, now)
  assert.equal(view.windows.fiveHour.billed, 200)
  assert.equal(view.windows.week.billed, 600)
  assert.equal(view.windows.month.billed, 1400)
  assert.equal(view.windows.month.requests, 3)
})

test('meter: pruning keeps only what the longest window can see', () => {
  const now = 10 * 24 * 60 * 60 * 1000
  const samples = [
    { at: now - 40 * 24 * 60 * 60 * 1000, billed: 1 },
    { at: now - 20 * 24 * 60 * 60 * 1000, billed: 1 },
    { at: now, billed: 1 },
  ]
  const kept = pruneSamples(samples, now)
  assert.equal(kept.length, 2)
  assert.equal(kept[0].at, now - 20 * 24 * 60 * 60 * 1000)
})

test('meter: an empty month still reports zero windows, not a missing field', () => {
  const view = meterView(null, Date.now())
  assert.equal(view.windows.fiveHour.billed, 0)
  assert.equal(view.windows.month.requests, 0)
  assert.equal(view.lastAt, null)
})

test('meter: sumWindow treats the window edge as inside', () => {
  // `(now - W, now]`: a request stamped exactly on the edge is still part of
  // the window. The choice only matters for a millisecond, but it has to be
  // one choice everywhere — pruning uses the same comparison.
  const now = 1000
  const samples = [{ at: now - 500, billed: 7 }]
  assert.equal(sumWindow(samples, 500, now).billed, 7)
  assert.equal(sumWindow(samples, 499, now).billed, 0)
})

test('refs: the credentials file block is read the way the store writes it', () => {
  const refs = parseRefs([
    'version: 1',
    'refs:',
    "  QIANFAN_API_KEY: 'bce-v3/ALTAK-abc'",
    '  BAIDU_QIANFAN_COOKIE: BAIDUID=x; bce-login=y',
    'records:',
    '  llm-pi-ai/openai-codex:',
    '    kind: grant',
  ].join('\n'))
  assert.equal(refs.get('QIANFAN_API_KEY'), 'bce-v3/ALTAK-abc')
  assert.equal(refs.get('BAIDU_QIANFAN_COOKIE'), 'BAIDUID=x; bce-login=y')
  assert.equal(refs.has('kind'), false)
})