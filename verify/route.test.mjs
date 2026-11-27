/**
 * Offline harness for the two host routes in lib/usage-meter.js.
 *
 * Mounts the real routes against a stub context (a registered-handler map, a
 * stub `webServer`, a stub credential store) and drives them with fake
 * request/response pairs. It proves the route contract — method handling, the
 * gate, what a save does and refuses, what the answer carries — not that a
 * browser renders it.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { mountUsageRoutes } from '../lib/usage-meter.js'

/** A response stand-in that records what the handler wrote. */
function fakeResponse() {
  const chunks = []
  return {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end(body) {
      if (body !== undefined) chunks.push(String(body))
      this.body = chunks.join('')
    },
    json() {
      return JSON.parse(this.body)
    },
  }
}

/** A request stand-in; `body` is delivered as one chunk. */
function fakeRequest({ method = 'GET', url = '/', body, headers = {} } = {}) {
  const listeners = {}
  const req = {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    on(event, handler) {
      listeners[event] = handler
      return req
    },
    destroy() {},
  }
  // Deliver the body on the next tick, the way a real stream would.
  setImmediate(() => {
    if (body !== undefined) listeners.data?.(Buffer.from(body))
    listeners.end?.()
  })
  return req
}

/** A credential store stand-in with the seam's four methods. */
function fakeCredentials(initial = {}) {
  const refs = new Map(Object.entries(initial))
  return {
    refs,
    async describe(ref) {
      const value = refs.get(ref)
      return value === undefined
        ? { configured: false, writable: true }
        : { configured: true, source: 'file', writable: true, masked: 'BAID…' + value.slice(-4) }
    },
    async set(ref, value) {
      if (value === '') throw new Error('empty value refused')
      refs.set(ref, value)
    },
    async unset(ref) {
      refs.delete(ref)
    },
  }
}

/**
 * Mount the routes.
 * @param options.credentials - credential store, or undefined for a profile
 *   without one.
 * @param options.config - row config the handlers read.
 * @param options.meter - meter state the handlers report.
 * @param options.gate - status the connection gate returns, when set.
 */
function mount({ credentials, config = {}, meter = null, gate } = {}) {
  const routes = {}
  const ctx = {
    effect(factory) {
      factory()
    },
    get(name) {
      if (name === 'connection') {
        return gate === undefined ? undefined : { requestRejection: () => gate }
      }
      return undefined
    },
    webServer: {
      register(route) {
        routes[route.path] = route.handler
        return () => {}
      },
    },
  }
  mountUsageRoutes(ctx, {
    configOf: () => config,
    meterOf: () => meter,
    credentialsOf: () => credentials,
  })
  return routes
}

/** Drive one handler to completion and return `{ status, body }`. */
async function call(handler, request) {
  const res = fakeResponse()
  await handler(request, res)
  return { status: res.statusCode, headers: res.headers, body: res.body === '' ? null : JSON.parse(res.body) }
}

// Meter state as the adapter actually holds it: raw samples, not computed
// windows — the route folds them itself. A sample stamped at epoch 1 would fall
// outside every window and report zeros, which is correct arithmetic but not the
// state under test.
/**
 * Keep the suite hermetic.
 *
 * `resolveCookie` falls back to `$DSH_HOME/.credentials.yaml`, and on a machine
 * that has a real console Cookie stored that fallback wins — so any test
 * asserting the "no Cookie" or "cleared" state flipped the moment the feature
 * started being used for real. Pointing DSH_HOME at an empty directory makes the
 * suite test the code instead of this developer's credentials.
 */
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'qf-route-test-'))
process.env.DSH_HOME = SANDBOX_HOME
process.env.BAIDU_QIANFAN_COOKIE = ''

const METER = () => ({ samples: [{ at: Date.now(), input: 900, cacheRead: 0, cacheWrite: 0, output: 100, billed: 1000 }] })

test('routes: both paths are registered on the exact router', () => {
  const routes = mount({ credentials: fakeCredentials() })
  assert.deepEqual(Object.keys(routes).sort(), ['/qianfan-usage/cookie', '/qianfan-usage/usage'])
})

test('gate: a rejected request is answered with the gate status and no body', async () => {
  const routes = mount({ credentials: fakeCredentials(), gate: 403 })
  const usage = await call(routes['/qianfan-usage/usage'], fakeRequest())
  assert.equal(usage.status, 403)
  const cookie = await call(routes['/qianfan-usage/cookie'], fakeRequest())
  assert.equal(cookie.status, 403)
})

test('usage: without a Cookie it answers no-cookie *and* the meter', async () => {
  const routes = mount({ credentials: fakeCredentials(), meter: METER() })
  const answer = await call(routes['/qianfan-usage/usage'], fakeRequest({ url: '/qianfan-usage/usage' }))
  assert.equal(answer.status, 200)
  assert.equal(answer.body.ok, false)
  assert.equal(answer.body.code, 'no-cookie')
  assert.equal(answer.body.meter.windows.month.billed, 1000)
  assert.equal(answer.headers['cache-control'], 'no-store')
})

test('usage: only GET and HEAD are accepted', async () => {
  const routes = mount({ credentials: fakeCredentials() })
  const answer = await call(routes['/qianfan-usage/usage'], fakeRequest({ method: 'POST', url: '/qianfan-usage/usage' }))
  assert.equal(answer.status, 405)
  assert.equal(answer.headers.allow, 'GET, HEAD')
})

test('cookie: a row-config Cookie counts as configured, from config', async () => {
  // A row-config Cookie must carry BDUSS too, for the same reason a saved one
  // does: without the session every other console cookie reads as configured
  // and then fails upstream.
  const routes = mount({ credentials: fakeCredentials(), config: { cookie: 'BDUSS=abc; BAIDUID=def' } })
  const answer = await call(routes['/qianfan-usage/cookie'], fakeRequest({ url: '/qianfan-usage/cookie' }))
  assert.equal(answer.body.configured, true)
  assert.equal(answer.body.source, 'config')
  // The value itself must never come back.
  assert.equal(answer.body.raw, true)
  assert.equal(JSON.stringify(answer.body).includes('BDUSS=abc'), false)
})

test('cookie: an inference API key is refused with the reason it is refused', async () => {
  const routes = mount({ credentials: fakeCredentials() })
  const answer = await call(
    routes['/qianfan-usage/cookie'],
    fakeRequest({
      method: 'POST',
      url: '/qianfan-usage/cookie',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cookie: 'bce-v3/ALTAK-abc' }),
    }),
  )
  assert.equal(answer.body.ok, false)
  // Its own code, not the generic `shape`: the message and the fix differ.
  assert.equal(answer.body.code, 'api-key')
  assert.match(answer.body.message, /API Key/)
})

test('cookie: a header missing BDUSS explains why the readable cookies cannot work', async () => {
  const routes = mount({ credentials: fakeCredentials() })
  const answer = await call(
    routes['/qianfan-usage/cookie'],
    fakeRequest({
      method: 'POST',
      url: '/qianfan-usage/cookie',
      body: JSON.stringify({ cookie: 'BAIDUID=abc; bce-passport-stoken=def' }),
    }),
  )
  assert.equal(answer.body.ok, false)
  assert.equal(answer.body.code, 'shape')
  // The fix has to be the one gesture the browser can actually perform, since
  // BDUSS is HttpOnly and never appears in document.cookie.
  assert.match(answer.body.message, /BDUSS/)
  assert.match(answer.body.message, /Copy as cURL/)
})

test('cookie: a malformed header is refused without a network round trip', async () => {
  const routes = mount({ credentials: fakeCredentials() })
  const answer = await call(
    routes['/qianfan-usage/cookie'],
    fakeRequest({
      method: 'POST',
      url: '/qianfan-usage/cookie',
      body: JSON.stringify({ cookie: 'no equals sign at all' }),
    }),
  )
  assert.equal(answer.body.code, 'shape')
})

test('cookie: an empty body is refused before reaching the store', async () => {
  const credentials = fakeCredentials()
  const routes = mount({ credentials })
  const answer = await call(
    routes['/qianfan-usage/cookie'],
    fakeRequest({ method: 'POST', url: '/qianfan-usage/cookie', body: '{}' }),
  )
  assert.equal(answer.body.code, 'empty')
  assert.equal(credentials.refs.size, 0)
})

test('cookie: a profile with no credential store says so instead of throwing', async () => {
  const routes = mount({ credentials: undefined })
  const answer = await call(
    routes['/qianfan-usage/cookie'],
    fakeRequest({ method: 'POST', url: '/qianfan-usage/cookie', body: JSON.stringify({ cookie: 'a=1' }) }),
  )
  assert.equal(answer.body.ok, false)
  assert.equal(answer.body.code, 'no-store')
})

test('cookie: DELETE clears the stored value', async () => {
  const credentials = fakeCredentials({ BAIDU_QIANFAN_COOKIE: 'a=1' })
  const routes = mount({ credentials })
  const answer = await call(
    routes['/qianfan-usage/cookie'],
    fakeRequest({ method: 'DELETE', url: '/qianfan-usage/cookie' }),
  )
  assert.equal(answer.body.cleared, true)
  assert.equal(answer.body.configured, false)
  assert.equal(credentials.refs.size, 0)
})

test('cookie: an unexpected method is a 405 with the allowed list', async () => {
  const routes = mount({ credentials: fakeCredentials() })
  const answer = await call(routes['/qianfan-usage/cookie'], fakeRequest({ method: 'PUT', url: '/qianfan-usage/cookie' }))
  assert.equal(answer.status, 405)
  assert.equal(answer.headers.allow, 'GET, HEAD, POST, DELETE')
})