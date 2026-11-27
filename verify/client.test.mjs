/**
 * Offline harness for dsh-llm-qianfan/lib/client.js.
 *
 * Runs the real bundle the browser receives, with a fake module loader, a
 * minimal React (hooks + createElement), and hand-fed host readings, then
 * inspects the produced element tree. It proves the bundle's own logic and its
 * render states; it cannot prove what the page paints.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/**
 * Run the bundle and return its exported module.
 * @param options.state - values fed to successive `useState` calls, so a
 *   component can be rendered in a settled state instead of its loading state.
 */
function load({ state = [], expanded = false } = {}) {
  let captured = null
  const windowStub = {
    localStorage: { getItem: () => (expanded ? '1' : null), setItem() {} },
    __ModuleLoader__: {
      load({ id, factory }) {
        captured = { id, factory }
      },
    },
  }
  const run = new Function('window', 'document', SOURCE)
  run(windowStub, { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' })
  assert.ok(captured !== null, 'bundle registered no module')
  assert.equal(captured.id, 'dsh-llm-qianfan')
  let index = 0
  const fakeReact = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) }
    },
    useState(initial) {
      const value = index < state.length ? state[index] : typeof initial === 'function' ? initial() : initial
      index += 1
      return [value, () => {}]
    },
    useRef(initial) {
      return { current: initial }
    },
    useEffect() {},
    useMemo(fn) {
      return fn()
    },
    useCallback(fn) {
      return fn
    },
  }
  return captured.factory(() => fakeReact)
}

const api = load()

/** Every string under one element tree, resolving nested function components. */
function textsOf(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textsOf(child, out)
    return out
  }
  if (typeof node.type === 'function') {
    textsOf(node.type(node.props), out)
    return out
  }
  for (const child of node.children ?? []) textsOf(child, out)
  return out
}

/** One host reading carrying both halves. */
function reading(overrides = {}) {
  return {
    ok: true,
    plan: {
      billingMode: 'credit',
      unit: 'credits',
      used: 18450,
      total: 45000,
      remaining: 26550,
      percent: 41,
      expiresAt: Date.parse('2026-12-27T02:00:00Z'),
      autoRenew: true,
      planKey: 'pro',
    },
    meter: {
      windows: {
        fiveHour: { billed: 120000, input: 90000, cacheRead: 20000, cacheWrite: 0, output: 10000, requests: 4 },
        week: { billed: 900000, input: 700000, cacheRead: 150000, cacheWrite: 0, output: 50000, requests: 19 },
        month: { billed: 4200000, input: 3200000, cacheRead: 800000, cacheWrite: 0, output: 200000, requests: 88 },
      },
      lastAt: Date.parse('2026-11-27T01:00:00Z'),
    },
    fetchedAt: '2026-11-27T01:00:00Z',
    ...overrides,
  }
}

test('parse: a real reading keeps both halves', () => {
  const parsed = api.parseReading(reading())
  assert.equal(parsed.ok, true)
  assert.equal(parsed.plan.unit, 'credits')
  assert.equal(parsed.plan.percent, 41)
  assert.equal(parsed.meter.windows.month.billed, 4200000)
})

test('parse: a no-cookie answer still carries the meter', () => {
  const parsed = api.parseReading({
    ok: false,
    code: 'no-cookie',
    message: '未配置控制台 Cookie',
    meter: reading().meter,
  })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.code, 'no-cookie')
  assert.equal(parsed.meter.windows.week.billed, 900000)
})

test('parse: junk in the meter does not become a rendered zero', () => {
  const parsed = api.parseReading({
    ok: false,
    meter: { windows: { month: { billed: 'lots' }, week: { billed: -1 } }, lastAt: 'yesterday' },
  })
  assert.equal(parsed.meter.windows.month, null)
  assert.equal(parsed.meter.windows.week, null)
  assert.equal(parsed.meter.lastAt, null)
})

test('parse: a non-object answer is a shape failure with no plan', () => {
  const parsed = api.parseReading('nope')
  assert.equal(parsed.ok, false)
  assert.equal(parsed.code, 'shape')
  assert.equal(parsed.plan, null)
})

test('format: percentages clamp and keep a sub-1% reading visible', () => {
  assert.equal(api.formatPercent(41.4), '41%')
  assert.equal(api.formatPercent(0.4), '0.4%')
  assert.equal(api.formatPercent(140), '100%')
  assert.equal(api.formatPercent(-3), '0%')
  assert.equal(api.formatPercent(null), '—')
})

test('format: amounts group, compact magnitudes stay short', () => {
  assert.equal(api.formatAmount(45000), '45,000')
  assert.equal(api.formatAmount(230000000), '230,000,000')
  assert.equal(api.formatCompact(4200000), '420.0 万')
  assert.equal(api.formatCompact(230000000), '2.30 亿')
  assert.equal(api.formatCompact(999), '999')
})

test('tone: the bar warns before the plan is spent', () => {
  assert.equal(api.toneOf(10), 'ok')
  assert.equal(api.toneOf(70), 'warn')
  assert.equal(api.toneOf(99), 'warn')
  assert.equal(api.toneOf(100), 'danger')
  assert.equal(api.toneOf(null), 'muted')
})

test('countdown: a lapsed subscription says so instead of a negative clock', () => {
  assert.equal(api.formatCountdown(-1), '已到期')
  assert.equal(api.formatCountdown(90_000), '1 分钟')
  assert.equal(api.formatCountdown(3 * 3_600_000), '3 小时')
  assert.equal(api.formatCountdown(2 * 86_400_000 + 5 * 3_600_000), '2 天 5 小时')
  assert.equal(api.formatCountdown(null), null)
})

test('summary: collapsed line names the official share and the local month', () => {
  const line = api.summarize(api.parseReading(reading()))
  assert.match(line, /41%/)
  assert.match(line, /18,450 \/ 45,000 积分/)
  assert.match(line, /本机计量 420\.0 万 tokens/)
})

test('summary: without a Cookie the line says so and keeps the meter', () => {
  const line = api.summarize(api.parseReading({
    ok: false,
    code: 'no-cookie',
    message: '未配置',
    meter: reading().meter,
  }))
  assert.match(line, /未配置控制台 Cookie/)
  assert.match(line, /本机计量/)
})

test('summary: a failed read is not dressed up as a reading', () => {
  const line = api.summarize(api.parseReading({ ok: false, code: 'login', message: '登录已过期' }))
  assert.match(line, /官方额度不可读/)
  assert.equal(/%/.test(line), false)
})

test('render: the card draws the plan bar and one bar per meter window', () => {
  const settled = load({ state: [reading(), 'ready', true], expanded: true })
  const tree = settled.QianfanUsage()
  assert.equal(tree.props['data-dsh-qianfan-usage'], 'true')
  const all = textsOf(tree).join('\n')
  assert.match(all, /千帆 Token Plan/)
  assert.match(all, /套餐额度/)
  // The plan bar reads the console's own numbers.
  assert.match(all, /已用 18,450 \/ 45,000 积分/)
  // Each meter window is its own row, labelled as this machine's accounting.
  assert.match(all, /本机计量 · 5 小时/)
  assert.match(all, /本机计量 · 本周/)
  assert.match(all, /本机计量 · 本月/)
})

test('render: expiry is a countdown, and auto-renew is stated', () => {
  const settled = load({ state: [reading(), 'ready', true], expanded: true })
  const all = textsOf(settled.QianfanUsage()).join('\n')
  assert.match(all, /套餐到期/)
  assert.match(all, /自动续费/)
})

test('render: a no-cookie answer keeps the meter rows and explains the gap', () => {
  const settled = load({
    state: [
      { ok: false, code: 'no-cookie', message: '未配置千帆控制台 Cookie', meter: reading().meter },
      'ready',
      true,
    ],
    expanded: true,
  })
  const all = textsOf(settled.QianfanUsage()).join('\n')
  assert.match(all, /未配置控制台 Cookie/)
  assert.match(all, /本机计量 · 本月/)
  // No official bar, because there is no official number.
  assert.equal(/已用 [\d,]+ \/ /.test(all), false)
})

test('render: the collapsed card is one row and has a refresh control', () => {
  const tree = api.QianfanUsage()
  const buttons = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.type === 'button') buttons.push(node)
    ;(node.children ?? []).forEach(walk)
  }
  walk(tree)
  assert.equal(buttons.length, 2, 'refresh and expand')
  assert.equal(buttons[0].props['data-qianfan-refresh'], 'true')
  assert.equal(buttons[1].props['aria-expanded'], 'false')
})

test('settings: the Cookie page never echoes a stored value', () => {
  const tree = api.QianfanCookiePage()
  assert.equal(tree.props['data-dsh-qianfan-cookie-page'], 'true')
  const inputs = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.type === 'input') inputs.push(node)
    ;(node.children ?? []).forEach(walk)
  }
  walk(tree)
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0].props.type, 'password')
  assert.equal(inputs[0].props.value, '', 'the field starts empty, never pre-filled')
})

test('plugin: registers a dock entry and a settings section', () => {
  const registered = []
  const ctx = {
    get: (name) => (name === 'slots'
      ? {
          inject: (slot, factory) => factory(),
          register: (options, component) => registered.push({ slot: options.name, id: options.id, component }),
        }
      : undefined),
  }
  api.apply(ctx)
  assert.deepEqual(registered.map((entry) => entry.slot), ['conversation.input.dock', 'settings.section'])
  assert.deepEqual(registered.map((entry) => entry.id), ['qianfan-usage', 'qianfan-usage-cookie'])
})

test('plugin: a context without slots is a no-op, not a crash', () => {
  assert.doesNotThrow(() => api.apply({ get: () => undefined }))
  assert.doesNotThrow(() => api.apply({}))
})