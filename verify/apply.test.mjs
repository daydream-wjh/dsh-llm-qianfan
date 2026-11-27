/**
 * Offline harness for dsh-llm-qianfan's `apply()`.
 *
 * Mounts the real plugin against a stub Cordis context and drives it the way the
 * host does: the provider route registers on `llm`, the usage feature mounts
 * inside an optional `webServer` scope, and an adapter stream feeds the meter.
 * This is what catches "the routes were never registered" before a restart,
 * because a restart is the only way to find out otherwise.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, inject, name } from '../index.js'

/**
 * Keep the suite hermetic.
 *
 * `apply()` resolves credentials through `resolveCookie`, whose last fallback is
 * `$DSH_HOME/.credentials.yaml`. Once a real console Cookie is stored there, the
 * "no credential" warning never fires and the route answers with live quota
 * instead of `no-cookie` — the suite would then be testing this machine's
 * account rather than the code. Both are redirected to an empty sandbox.
 */
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'qf-apply-test-'))
process.env.DSH_HOME = SANDBOX_HOME
process.env.BAIDU_QIANFAN_COOKIE = ''

/**
 * Build a stub context.
 * @param options.webServer - whether the profile serves the Web surface.
 * @param options.credentials - the credential store, when the profile has one.
 */
function fakeContext({ webServer = true, credentials = undefined } = {}) {
  const state = {
    adapters: [],
    providers: [],
    discoveries: [],
    routes: {},
    scopes: [],
    warnings: [],
  }

  /** A scope is a context that can resolve the declared services itself. */
  const makeScope = (services) => ({
    get(serviceName) {
      if (serviceName === 'webServer' && webServer) return scopeCtx.webServer
      if (serviceName === 'connection') return { requestRejection: () => undefined }
      if (serviceName === 'credentials') return credentials
      throw new Error(`cannot get property "${serviceName}" without inject`)
    },
    inject(dependencies, callback) {
      for (const dependency of dependencies) {
        if (dependency === 'credentials' && credentials === undefined) return undefined
      }
      const nested = makeScope([...services, ...dependencies])
      callback(nested)
      return nested
    },
    effect(factory) {
      return factory()
    },
    get webServer() {
      return webServer
        ? {
            register(route) {
              state.routes[route.path] = route.handler
              return () => {
                delete state.routes[route.path]
              }
            },
          }
        : undefined
    },
  })

  const scopeCtx = makeScope([])

  const ctx = {
    fiber: { entry: { options: { id: 'llm-qianfan' } } },
    logger: {
      info() {},
      warn(message) {
        state.warnings.push(message)
      },
    },
    get(serviceName) {
      return scopeCtx.get(serviceName)
    },
    inject(dependencies, callback) {
      // The host skips the scope entirely when one declared service is absent.
      if (!webServer && dependencies.includes('webServer')) return undefined
      const nested = makeScope(dependencies)
      callback(nested)
      return nested
    },
    effect(factory) {
      return factory()
    },
    llm: {
      registerAdapter(providers, adapter) {
        state.adapters.push({ providers, adapter })
      },
      registerConfigurableProviders(rows) {
        state.providers.push(...rows)
      },
      registerModelDiscovery(namespace, discover) {
        state.discoveries.push({ namespace, discover })
      },
    },
  }
  return { ctx, state }
}

test('plugin: the provider route registers under the qianfan provider', () => {
  const { ctx, state } = fakeContext()
  apply(ctx, {})
  assert.equal(name, 'llm-qianfan')
  assert.deepEqual(state.adapters.map((entry) => entry.providers), [['qianfan']])
  assert.equal(state.adapters[0].adapter.providerInfo('qianfan').name, 'Qianfan Token Plan')
})

test('plugin: declares the llm seam it cannot work without', () => {
  assert.deepEqual(inject, ['llm'])
})

test('plugin: the usage routes mount when the profile serves Web', () => {
  const { ctx, state } = fakeContext()
  apply(ctx, {})
  assert.deepEqual(
    Object.keys(state.routes).sort(),
    ['/qianfan-usage/cookie', '/qianfan-usage/usage'],
  )
  // Warnings are filtered to the ones this test is about: the sandbox has no
  // provider key, so the credential notice is expected and irrelevant here.
  assert.deepEqual(state.warnings.filter((line) => !/without a usable credential/.test(line)), [],
    'mounting must not warn beyond the missing provider key')
})

test('plugin: a profile without a Web server keeps the provider route and skips the card', () => {
  const { ctx, state } = fakeContext({ webServer: false })
  apply(ctx, {})
  assert.equal(state.adapters.length, 1, 'the provider must still register')
  assert.deepEqual(state.routes, {}, 'no routes on a headless profile')
  assert.deepEqual(state.warnings.filter((line) => !/without a usable credential/.test(line)), [],
    'a headless profile is not an error')
})

test('plugin: a throwing scope does not take the provider route down', () => {
  const { ctx, state } = fakeContext()
  const originalInject = ctx.inject
  ctx.inject = () => {
    throw new Error('scope unavailable')
  }
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.equal(state.adapters.length, 1)
  const scope = state.warnings.filter((line) => /usage readout scope failed/.test(line))
  assert.equal(scope.length, 1)
  ctx.inject = originalInject
})

test('plugin: no credential leaves a warning and still mounts', () => {
  const { ctx, state } = fakeContext()
  const before = { key: process.env.QIANFAN_API_KEY, home: process.env.DSH_HOME }
  // Point both credential sources away from the developer's own store: this
  // test asserts the missing-credential path, and the machine running it almost
  // certainly has a real key configured.
  delete process.env.QIANFAN_API_KEY
  process.env.DSH_HOME = '/nonexistent-dsh-home-for-test'
  try {
    apply(ctx, { apiKey: '', credentialsFile: '/nonexistent/.credentials.yaml' })
  } finally {
    if (before.key !== undefined) process.env.QIANFAN_API_KEY = before.key
    if (before.home === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before.home
  }
  assert.equal(state.adapters.length, 1)
  assert.ok(state.warnings.some((line) => /without a usable credential/.test(line)))
})

test('adapter: a usage report reaches the meter the routes read', async () => {
  const { ctx, state } = fakeContext()
  // The adapter reads a key at stream time. Supply a synthetic one so this test
  // exercises the usage path rather than the credential path; nothing leaves the
  // process, because `fetch` is replaced below.
  writeFileSync(join(SANDBOX_HOME, '.credentials.yaml'), "version: 1\nrefs:\n  QIANFAN_API_KEY: 'test-key'\n", { mode: 0o600 })
  apply(ctx, {})
  const adapter = state.adapters[0].adapter

  // Stand in for the network: the stream's shape after a successful call is
  // what matters to the meter, not the transport.
  const payload = [
    'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],'
      + '"usage":{"prompt_tokens":1000,"completion_tokens":50,"total_tokens":1050,'
      + '"prompt_tokens_details":{"cached_tokens":800},"completion_tokens_details":{"reasoning_tokens":10}}}',
    'data: [DONE]',
    '',
  ].join('\n\n')

  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload))
      controller.close()
    },
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Headers(), body })
  try {
    const events = []
    for await (const event of adapter.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) {
      events.push(event)
    }
    const usageEvent = events.find((event) => event.type === 'usage')
    assert.ok(usageEvent, 'the adapter must still yield its usage event')
    // Harness vocabulary stays disjoint: cached prompt tokens are not input.
    assert.equal(usageEvent.usage.inputTokens, 200)
    assert.equal(usageEvent.usage.cacheReadTokens, 800)
    assert.equal(usageEvent.usage.outputTokens, 50)

    // …and the same report is now visible through the route the card reads.
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(n, v) {
        this.headers[n] = v
      },
      end(body_) {
        this.body = body_
      },
    }
    await state.routes['/qianfan-usage/usage']({ method: 'GET', url: '/qianfan-usage/usage', headers: {} }, res)
    const answer = JSON.parse(res.body)
    assert.equal(answer.code, 'no-cookie', 'no console Cookie in the fixture')
    // Qianfan bills cached prompt tokens, so the plan meter counts all of it.
    assert.equal(answer.meter.windows.month.billed, 1050)
    assert.equal(answer.meter.windows.month.requests, 1)
    assert.equal(answer.meter.windows.month.cacheRead, 800)
  } finally {
    globalThis.fetch = originalFetch
  }
})