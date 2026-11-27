/**
 * dsh-llm-qianfan — Token Plan usage card, client half.
 *
 * Adds one full-width entry above the composer card
 * (`conversation.input.dock`, a list slot, so nothing shipped is replaced) that
 * reports how much of the Qianfan Token Plan is spent, plus a settings section
 * that stores the console Cookie the official number needs.
 *
 * Two readings are shown side by side on purpose:
 *
 *  - **套餐额度** — the console's own numbers (`used / total`, percent, expiry).
 *    This is the only authoritative source, and it needs the logged-in
 *    console.bce.baidu.com Cookie: Baidu publishes no key-authenticated quota
 *    route, so the inference API key cannot answer it.
 *  - **本机计量** — what this machine's adapter actually billed, folded into the
 *    plan's 5-hour / weekly / monthly windows. It is labelled 本机 because it is
 *    a lower bound: the console counts every client of the subscription.
 *
 * The card therefore degrades in a useful way: no Cookie means the official
 * half says why and the local half still reports real numbers, instead of the
 * whole row disappearing or showing a fake zero.
 *
 * Contract notes:
 *  - The Cookie never reaches this code. The host resolves it; the browser only
 *    learns whether one is configured and the store's masked preview.
 *  - Poll cadence is one minute while the page is visible, matching the host's
 *    cache TTL; a saved Cookie refreshes immediately instead of waiting.
 *  - Styles are inline with `--dsw-*` tokens and safe fallbacks, so the entry
 *    follows the active theme.
 */
window.__ModuleLoader__.load({
  id: 'dsh-llm-qianfan',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement

    /** The composer dock: a list slot, so this is an addition, not a takeover. */
    const SLOT = 'conversation.input.dock'
    const ENTRY_ID = 'qianfan-usage'
    /** Settings navigation section for the console Cookie. */
    const SETTINGS_SLOT = 'settings.section'
    const SETTINGS_ID = 'qianfan-usage-cookie'
    /** Host routes (relative: the page is served from the same origin). */
    const USAGE_ROUTE = '/qianfan-usage/usage'
    const COOKIE_ROUTE = '/qianfan-usage/cookie'
    /** Fired after a Cookie change so the card re-reads instead of waiting. */
    const COOKIE_EVENT = 'dsh-llm-qianfan:cookie-changed'
    const PREF_KEY = 'dsh.llm-qianfan.usage.expanded'
    /** Poll cadence while visible; the host caches the official read for 60s. */
    const POLL_MS = 60_000
    /** Above this spend share the bar turns warning; at 100 it is spent. */
    const WARN_AT = 70

    const COLOR = {
      text1: 'var(--dsw-alias-label-primary, #1f2329)',
      text2: 'var(--dsw-alias-label-secondary, #5c6068)',
      text3: 'var(--dsw-alias-label-tertiary, #8b8f96)',
      accent: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
      warn: 'var(--dsw-alias-state-warning-primary, #d97706)',
      danger: 'var(--dsw-alias-state-error-primary, #d92d20)',
      border: 'var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.22))',
      menu: 'var(--dsw-specific-menu, var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.06)))',
    }

    const TEXT = {
      title: '千帆 Token Plan',
      official: '套餐额度',
      local: '本机计量',
      fiveHour: '5 小时',
      week: '本周',
      month: '本月',
      used: '已用',
      expires: '套餐到期',
      autoRenew: '自动续费',
      refresh: '刷新',
      expand: '展开明细',
      collapse: '收起明细',
      loading: '读取额度…',
      failed: '读取失败',
      cached: '缓存',
      noCookie: '未配置控制台 Cookie',
      requests: '次请求',
      serverBilled: '服务端计费',
      updated: '更新于',
      quotaUnknown: '官方额度不可读',
      never: '还没记录到本机用量',
    }

    /* ---------------------------------------------------------------- *
     * Pure readers (exported for the offline harness)
     * ---------------------------------------------------------------- */

    /** A finite non-negative number, or null. */
    function amountOf(value) {
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
    }

    /**
     * Clamp into 0..100, or null when it is not a number.
     *
     * Unlike `amountOf`, a negative value is accepted and clamped: a percentage
     * arrives from arithmetic on two amounts, and a slightly negative share is a
     * rounding artefact that should read as 0%, not as a missing value.
     */
    function percentOf(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null
      return Math.max(0, Math.min(100, value))
    }

    /**
     * Format a token or credit amount for display.
     *
     * The card shows both, and the two have very different magnitudes: a
     * credit total is often under 100k with fractional consumption, a token
     * total runs to hundreds of millions. `toLocaleString` keeps the grouping
     * honest, and `maximumFractionDigits` keeps a credit figure from rendering
     * as a long decimal.
     */
    function formatAmount(value) {
      const amount = amountOf(value)
      if (amount === null) return '—'
      return amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
    }

    /** Compact token magnitude for the collapsed line (`12.4 亿`, `83 万`). */
    function formatCompact(value) {
      const amount = amountOf(value)
      if (amount === null) return '—'
      if (amount >= 1e8) return (amount / 1e8).toFixed(2) + ' 亿'
      if (amount >= 1e4) return (amount / 1e4).toFixed(1) + ' 万'
      return String(Math.round(amount))
    }

    /** Percentage label; one decimal below 1% so 0.4% does not read as zero. */
    function formatPercent(percent) {
      const value = percentOf(percent)
      if (value === null) return '—'
      if (value > 0 && value < 1) return value.toFixed(1) + '%'
      return Math.round(value) + '%'
    }

    /** Tone of a spend share: normal, warning, or spent. */
    function toneOf(percent) {
      const value = percentOf(percent)
      if (value === null) return 'muted'
      if (value >= 100) return 'danger'
      if (value >= WARN_AT) return 'warn'
      return 'ok'
    }

    /** Colour for a tone. */
    function colorOf(tone) {
      if (tone === 'danger') return COLOR.danger
      if (tone === 'warn') return COLOR.warn
      if (tone === 'muted') return COLOR.text3
      return COLOR.accent
    }

    /** Local wall-clock label, or null. */
    function formatClock(ms) {
      if (typeof ms !== 'number' || Number.isNaN(ms)) return null
      try {
        return new Date(ms).toLocaleString('zh-CN', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      } catch {
        return null
      }
    }

    /**
     * Countdown to a moment, or null when it is not a moment.
     * @param ms - milliseconds remaining; negative means already due.
     */
    function formatCountdown(ms) {
      if (typeof ms !== 'number' || Number.isNaN(ms)) return null
      if (ms <= 0) return '已到期'
      const minutes = Math.floor(ms / 60_000)
      if (minutes < 1) return '不到 1 分钟'
      const days = Math.floor(minutes / 1440)
      const hours = Math.floor((minutes % 1440) / 60)
      if (days > 0) return days + ' 天' + (hours > 0 ? ' ' + hours + ' 小时' : '')
      if (hours > 0) return hours + ' 小时'
      return minutes % 60 + ' 分钟'
    }

    /**
     * Take one host reading apart into what the card renders.
     *
     * The host may answer three ways: a real quota (`ok: true` with `plan`), a
     * soft failure (`no-cookie`, `login`, `timeout`) that still carries a meter,
     * or a transport break with nothing at all. All three keep `meter`, because
     * the local half is independent of the console.
     * @param reading - decoded host response, or anything else.
     * @returns the normalized view.
     */
    function parseReading(reading) {
      if (reading === null || typeof reading !== 'object') {
        return {
          ok: false,
          code: 'shape',
          message: TEXT.failed,
          plan: null,
          meter: null,
          fetchedAt: null,
        }
      }
      const fetchedAt = typeof reading.fetchedAt === 'string' ? Date.parse(reading.fetchedAt) : NaN
      const plan = reading.plan !== null && typeof reading.plan === 'object'
        ? {
            billingMode: reading.plan.billingMode === 'credit' ? 'credit' : 'token',
            unit: reading.plan.unit === 'credits' ? 'credits' : 'tokens',
            used: amountOf(reading.plan.used),
            total: amountOf(reading.plan.total),
            remaining: amountOf(reading.plan.remaining),
            percent: percentOf(reading.plan.percent),
            expiresAt: typeof reading.plan.expiresAt === 'number' ? reading.plan.expiresAt : null,
            autoRenew: reading.plan.autoRenew === true,
            planKey: typeof reading.plan.planKey === 'string' ? reading.plan.planKey : null,
          }
        : null

      const source = reading.meter !== null && typeof reading.meter === 'object' ? reading.meter : null
      const windowOf = (name) => {
        const entry = source?.windows?.[name]
        if (entry === null || typeof entry !== 'object') return null
        const billed = amountOf(entry.billed)
        if (billed === null) return null
        return {
          billed,
          input: amountOf(entry.input) ?? 0,
          cacheRead: amountOf(entry.cacheRead) ?? 0,
          cacheWrite: amountOf(entry.cacheWrite) ?? 0,
          output: amountOf(entry.output) ?? 0,
          requests: amountOf(entry.requests) ?? 0,
        }
      }
      const windows = {
        fiveHour: windowOf('fiveHour'),
        week: windowOf('week'),
        month: windowOf('month'),
      }
      const meter = source === null
        ? null
        : {
            windows,
            lastAt: typeof source.lastAt === 'number' ? source.lastAt : null,
          }

      return {
        ok: reading.ok === true && plan !== null,
        code: typeof reading.code === 'string' ? reading.code : undefined,
        message: typeof reading.message === 'string' && reading.message !== '' ? reading.message : TEXT.failed,
        plan,
        meter,
        cached: reading.cached === true,
        fetchedAt: Number.isNaN(fetchedAt) ? null : fetchedAt,
      }
    }

    /** The one-line summary shown while collapsed. */
    function summarize(parsed) {
      const parts = []
      if (parsed.ok && parsed.plan !== null) {
        parts.push(TEXT.official + ' ' + formatPercent(parsed.plan.percent)
          + '（' + formatAmount(parsed.plan.used) + ' / ' + formatAmount(parsed.plan.total)
          + (parsed.plan.unit === 'credits' ? ' 积分' : ' Tokens') + '）')
      } else if (parsed.code === 'no-cookie') {
        parts.push(TEXT.noCookie)
      } else if (parsed.code !== undefined) {
        parts.push(TEXT.quotaUnknown)
      }
      const month = parsed.meter?.windows?.month
      if (month !== null && month !== undefined && month.billed > 0) {
        parts.push(TEXT.local + ' ' + formatCompact(month.billed) + ' tokens')
      }
      return parts.join(' · ')
    }

    /** Expand preference survives reloads. */
    function readExpandedPreference() {
      try {
        return window.localStorage.getItem(PREF_KEY) === '1'
      } catch {
        return false
      }
    }

    function writeExpandedPreference(value) {
      try {
        window.localStorage.setItem(PREF_KEY, value ? '1' : '0')
      } catch {}
    }

    /* ---------------------------------------------------------------- *
     * Components
     * ---------------------------------------------------------------- */

    function buttonStyle() {
      return {
        flex: 'none',
        border: 'none',
        background: 'transparent',
        color: COLOR.text2,
        cursor: 'pointer',
        fontSize: '12px',
        lineHeight: '20px',
        padding: '0 4px',
        borderRadius: '6px',
      }
    }

    /** One labelled progress bar, used for the plan and each meter window. */
    function BarRow({ label, percent, caption, color, hint }) {
      return h(
        'div',
        {
          style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '3px 0' },
        },
        h(
          'span',
          {
            style: { flex: 'none', width: '64px', color: COLOR.text2, fontSize: '12.5px', lineHeight: '18px' },
          },
          label,
        ),
        h(
          'span',
          {
            style: {
              flex: 'none',
              width: '46px',
              textAlign: 'right',
              color: color,
              fontSize: '12.5px',
              lineHeight: '18px',
              fontVariantNumeric: 'tabular-nums',
            },
          },
          percent === null ? '—' : formatPercent(percent),
        ),
        h(
          'span',
          {
            title: hint,
            style: {
              flex: '1 1 auto',
              height: '4px',
              borderRadius: '999px',
              background: 'rgba(127, 127, 127, 0.18)',
              overflow: 'hidden',
            },
          },
          h('span', {
            style: {
              display: 'block',
              width: Math.max(percent === null ? 0 : 1, percent ?? 0) + '%',
              height: '100%',
              borderRadius: '999px',
              background: color,
            },
          }),
        ),
        h(
          'span',
          {
            style: {
              flex: 'none',
              minWidth: '96px',
              textAlign: 'right',
              color: COLOR.text3,
              fontSize: '12px',
              lineHeight: '18px',
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            },
          },
          caption,
        ),
      )
    }

    /** The expanded body: official plan numbers, then the three meter windows. */
    function Details({ parsed, now, failed }) {
      const rows = []
      if (parsed.plan !== null) {
        const plan = parsed.plan
        const expiry = plan.expiresAt === null ? null : formatCountdown(plan.expiresAt - now)
        rows.push(
          h(BarRow, {
            key: 'plan',
            label: plan.planKey === null ? TEXT.official : TEXT.official + ' · ' + plan.planKey,
            percent: plan.percent,
            color: colorOf(toneOf(plan.percent)),
            hint: text_used_total(plan),
            caption: text_used_total(plan),
          }),
        )
        if (expiry !== null) {
          rows.push(
            h(
              'div',
              {
                key: 'expiry',
                style: { color: COLOR.text3, fontSize: '11.5px', lineHeight: '18px', paddingTop: '2px' },
              },
              TEXT.expires + ' ' + (formatClock(plan.expiresAt) ?? '—') + '（' + expiry + '）'
                + (plan.autoRenew ? ' · ' + TEXT.autoRenew : ''),
            ),
          )
        }
      }

      // The monthly window is the one the plan itself tracks, so it is drawn
      // as a share of the plan total when the two use the same unit; the other
      // two windows are shown as raw amounts with their own bars scaled to the
      // month, which keeps "this week's share of this month" visible.
      const meter = parsed.meter
      const monthBilled = meter?.windows?.month?.billed ?? 0
      for (const name of ['fiveHour', 'week', 'month']) {
        const entry = meter?.windows?.[name]
        if (entry === null || entry === undefined) continue
        const share = monthBilled > 0 ? (entry.billed / monthBilled) * 100 : 0
        rows.push(
          h(BarRow, {
            key: name,
            label: TEXT.local + ' · ' + TEXT[name],
            percent: name === 'month' ? (monthBilled > 0 ? 100 : 0) : share,
            color: COLOR.text3,
            hint:
              TEXT.serverBilled + ' ' + formatAmount(entry.billed) + ' tokens'
              + '（' + entry.requests + ' ' + TEXT.requests + '）',
            caption: formatCompact(entry.billed) + ' · ' + entry.requests + TEXT.requests,
          }),
        )
      }

      if (rows.length === 0) {
        rows.push(
          h('div', { key: 'empty', style: { color: COLOR.text3, fontSize: '12px', lineHeight: '18px' } }, TEXT.never),
        )
      }

      const footer = []
      if (failed === true) footer.push(parsed.message)
      if (parsed.cached === true) footer.push(TEXT.cached)
      if (parsed.fetchedAt !== null) footer.push(TEXT.updated + ' ' + (formatClock(parsed.fetchedAt) ?? '—'))

      return h(
        'div',
        {
          'data-qianfan-details': 'true',
          style: { display: 'flex', flexDirection: 'column', padding: '2px 2px 6px' },
        },
        ...rows,
        footer.length === 0
          ? null
          : h(
              'div',
              {
                style: {
                  display: 'flex',
                  gap: '10px',
                  flexWrap: 'wrap',
                  color: COLOR.text3,
                  fontSize: '11.5px',
                  lineHeight: '18px',
                  paddingTop: '2px',
                },
              },
              ...footer.map((line, index) => h('span', { key: index }, line)),
            ),
      )
    }

    /** `已用 1,234 / 20,000 积分` — shared by the bar row and its tooltip. */
    function text_used_total(plan) {
      const unit = plan.unit === 'credits' ? ' 积分' : ' Tokens'
      return TEXT.used + ' ' + formatAmount(plan.used) + ' / ' + formatAmount(plan.total) + unit
    }

    function QianfanUsage() {
      const [reading, setReading] = React.useState(null)
      const [phase, setPhase] = React.useState('loading')
      const [expanded, setExpanded] = React.useState(readExpandedPreference)
      const [, setTick] = React.useState(0)
      const lastFetch = React.useRef(0)
      const inFlight = React.useRef(false)

      const load = React.useCallback(async (force) => {
        if (inFlight.current) return
        inFlight.current = true
        lastFetch.current = Date.now()
        try {
          const response = await fetch(USAGE_ROUTE + (force ? '?force=1' : ''), {
            cache: 'no-store',
            headers: { accept: 'application/json' },
          })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          setReading(await response.json())
        } catch (error) {
          setReading({ ok: false, code: 'transport', message: String(error?.message ?? error) })
        } finally {
          setPhase('ready')
          inFlight.current = false
        }
      }, [])

      React.useEffect(() => {
        void load(false)
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          void load(false)
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [load])

      // A Cookie saved in settings changes what the official half can report;
      // waiting for the next poll would keep the old verdict for a minute.
      React.useEffect(() => {
        const onChanged = () => void load(true)
        window.addEventListener(COOKIE_EVENT, onChanged)
        return () => window.removeEventListener(COOKIE_EVENT, onChanged)
      }, [load])

      // Returning to the tab skips the wait for the next tick.
      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const onVisible = () => {
          if (document.visibilityState !== 'visible') return
          if (Date.now() - lastFetch.current >= POLL_MS) void load(false)
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => document.removeEventListener('visibilitychange', onVisible)
      }, [load])

      // Countdowns tick on their own clock, not on fetch results.
      React.useEffect(() => {
        const timer = setInterval(() => setTick((value) => value + 1), 30_000)
        return () => clearInterval(timer)
      }, [])

      const parsed = React.useMemo(() => parseReading(reading), [reading])
      const now = Date.now()
      const failed = !parsed.ok && parsed.code !== 'no-cookie'
      const dotTone = parsed.ok ? toneOf(parsed.plan?.percent) : 'muted'

      const toggle = () => {
        setExpanded((previous) => {
          const next = !previous
          writeExpandedPreference(next)
          return next
        })
      }

      const header = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            minWidth: '0',
            width: '100%',
            padding: '2px 4px 2px 0',
          },
        },
        h('span', {
          'data-qianfan-dot': dotTone,
          'aria-hidden': 'true',
          style: { flex: 'none', width: '7px', height: '7px', borderRadius: '999px', background: colorOf(dotTone) },
        }),
        h(
          'span',
          { style: { flex: 'none', color: COLOR.text1, fontSize: '13px', fontWeight: '500', lineHeight: '24px' } },
          TEXT.title,
        ),
        h(
          'span',
          {
            'data-qianfan-summary': 'true',
            title: failed ? parsed.message : summarize(parsed),
            style: {
              minWidth: '0',
              flex: '1 1 auto',
              color: failed ? COLOR.danger : COLOR.text3,
              fontSize: '12.5px',
              lineHeight: '20px',
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            },
          },
          phase === 'loading' && reading === null
            ? TEXT.loading
            : failed
              ? parsed.message
              : summarize(parsed),
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: () => void load(true),
            title: TEXT.refresh,
            'aria-label': TEXT.refresh,
            'data-qianfan-refresh': 'true',
            style: buttonStyle(),
          },
          '⟳',
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: toggle,
            title: expanded ? TEXT.collapse : TEXT.expand,
            'aria-expanded': expanded ? 'true' : 'false',
            style: buttonStyle(),
          },
          expanded ? '▴' : '▾',
        ),
      )

      return h(
        'div',
        {
          'data-dsh-qianfan-usage': 'true',
          style: {
            boxSizing: 'border-box',
            // The dock is a flex item in the composer stack, and the
            // new-conversation screen constrains that stack's height. Without
            // `flex: 0 0 auto` the row collapses to a sliver with clipped text.
            flex: '0 0 auto',
            width: '100%',
            maxWidth: 'var(--dsh-composer-card-max-width, 720px)',
            margin: '0 auto',
            padding: '0 12px 2px',
            borderRadius: 'var(--dsw-radius-md, 10px)',
            background: COLOR.menu,
            boxShadow: 'inset 0 0 0 1px ' + COLOR.border,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          },
        },
        header,
        expanded ? h(Details, { parsed, now, failed }) : null,
      )
    }

    /* ---------------------------------------------------------------- *
     * Settings: the console Cookie
     * ---------------------------------------------------------------- */

    const COOKIE_TEXT = {
      title: '千帆 Token Plan',
      intro:
        '套餐额度只有百度智能云控制台的口径。在 console.bce.baidu.com 登录并打开「我的订阅」后，'
        + '按 F12 打开「网络」，刷新页面，找到 tokenPlanPersonal/resource 请求，右键 →「Copy as cURL」，'
        + '把整段命令粘到下面。'
        + '直接从「应用」面板或 document.cookie 拿到的 Cookie 不够用：登录票 BDUSS 是 HttpOnly 的，'
        + '只有 Copy as cURL 会带上它。推理 API Key 更不能查额度，那是另一类凭据。',
      configured: '已配置',
      missing: '未配置',
      source: '来源',
      sourceFile: '凭据库',
      sourceEnv: '启动环境',
      sourceConfig: '插件配置',
      inputLabel: '控制台 Cookie',
      placeholder: "curl 'https://console.bce.baidu.com/api/qianfan/…' -H 'cookie: BDUSS=…'",
      save: '保存',
      saving: '保存中…',
      clear: '清除',
      clearing: '清除中…',
      saved: '已保存，卡片会立即重新读取额度。',
      cleared: '已清除，卡片回到只用本机计量的状态。',
      hint: '写入的凭据名：BAIDU_QIANFAN_COOKIE。Cookie 由凭据库保管，不会写入插件配置，也不会回传到页面。',
      noStore: '这个 profile 没有凭据存储，Cookie 无法保存；可改用环境变量 BAIDU_QIANFAN_COOKIE。',
      loading: '读取配置状态…',
      failed: '操作失败',
      login: '这段 Cookie 读不到额度：多半是登录过期了，或复制时没带上 BDUSS。重新登录控制台再 Copy as cURL 一次。',
      probe: 'Cookie 已保存，但这次读取失败：',
      localOnly: '不带 Cookie 也能看「本机计量」：那是这台机器上适配器实际计费掉的 token，按 5 小时 / 本周 / 本月统计。',
    }

    function KeyStatusLine({ configured, extra }) {
      const tone = configured ? 'ok' : 'muted'
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        h('span', {
          'aria-hidden': 'true',
          style: { flex: 'none', width: '7px', height: '7px', borderRadius: '999px', background: colorOf(tone) },
        }),
        h(
          'span',
          { style: { color: COLOR.text1, fontSize: '13px', fontWeight: 500 } },
          configured ? COOKIE_TEXT.configured : COOKIE_TEXT.missing,
        ),
        extra === null || extra === undefined || extra === ''
          ? null
          : h('span', { style: { color: COLOR.text3, fontSize: '12px' } }, extra),
      )
    }

    function QianfanCookiePage() {
      const [status, setStatus] = React.useState(null)
      const [phase, setPhase] = React.useState('loading')
      const [value, setValue] = React.useState('')
      const [notice, setNotice] = React.useState(null)

      const load = React.useCallback(async () => {
        setPhase('loading')
        try {
          const response = await fetch(COOKIE_ROUTE, { cache: 'no-store', headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const body = await response.json()
          setStatus(body)
          if (body.code === 'no-store') setNotice({ tone: 'warn', text: COOKIE_TEXT.noStore })
        } catch (error) {
          setStatus({ ok: false, code: 'transport', message: String(error?.message ?? error) })
        } finally {
          setPhase('ready')
        }
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      const submit = React.useCallback(
        async (method) => {
          if (phase === 'busy') return
          setPhase('busy')
          setNotice(null)
          try {
            const body = method === 'POST' ? JSON.stringify({ cookie: value }) : undefined
            const response = await fetch(COOKIE_ROUTE, {
              method,
              cache: 'no-store',
              headers: method === 'POST'
                ? { 'content-type': 'application/json', accept: 'application/json' }
                : { accept: 'application/json' },
              body,
            })
            if (!response.ok) throw new Error('HTTP ' + response.status)
            const answer = await response.json()
            setStatus(answer)
            if (answer.ok !== true) {
              setNotice({ tone: 'danger', text: answer.code === 'login' ? COOKIE_TEXT.login : answer.message ?? COOKIE_TEXT.failed })
            } else if (answer.saved === true) {
              setValue('')
              if (answer.probe !== undefined && answer.probe.ok !== true) {
                setNotice({ tone: 'warn', text: COOKIE_TEXT.probe + (answer.probe.message ?? '') })
              } else {
                setNotice({ tone: 'ok', text: COOKIE_TEXT.saved })
              }
              window.dispatchEvent(new CustomEvent(COOKIE_EVENT))
            } else if (answer.cleared === true) {
              setNotice({ tone: 'ok', text: COOKIE_TEXT.cleared })
              window.dispatchEvent(new CustomEvent(COOKIE_EVENT))
            }
          } catch (error) {
            setNotice({ tone: 'danger', text: String(error?.message ?? error) })
          } finally {
            setPhase('ready')
          }
        },
        [phase, value],
      )

      const configured = status !== null && status.configured === true
      const source = status !== null && typeof status.source === 'string'
        ? status.source === 'file'
          ? COOKIE_TEXT.sourceFile
          : status.source === 'config'
            ? COOKIE_TEXT.sourceConfig
            : COOKIE_TEXT.sourceEnv
        : null
      const masked = status !== null && typeof status.masked === 'string' ? status.masked : null
      const busy = phase === 'busy'

      const input = h('input', {
        type: 'password',
        value,
        placeholder: COOKIE_TEXT.placeholder,
        'aria-label': COOKIE_TEXT.inputLabel,
        autocomplete: 'off',
        autocapitalize: 'off',
        autocorrect: 'off',
        spellcheck: false,
        disabled: busy,
        onChange: (event) => setValue(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            void submit('POST')
          }
        },
        style: {
          boxSizing: 'border-box',
          flex: '1 1 260px',
          minWidth: '0',
          height: '32px',
          padding: '0 10px',
          borderRadius: 'var(--dsw-radius-md, 8px)',
          border: '1px solid ' + COLOR.border,
          background: 'transparent',
          color: COLOR.text1,
          fontSize: '13px',
          fontFamily: 'inherit',
          outline: 'none',
        },
      })

      const action = (label, onClick, tone, disabled) =>
        h(
          'button',
          {
            type: 'button',
            onClick,
            disabled,
            style: {
              boxSizing: 'border-box',
              flex: 'none',
              height: '32px',
              padding: '0 14px',
              borderRadius: 'var(--dsw-radius-md, 8px)',
              border: tone === 'danger' ? '1px solid ' + COLOR.border : '1px solid transparent',
              background: tone === 'primary' ? COLOR.accent : 'transparent',
              color: tone === 'primary' ? '#fff' : tone === 'danger' ? COLOR.danger : COLOR.text2,
              fontSize: '13px',
              fontFamily: 'inherit',
              cursor: disabled ? 'default' : 'pointer',
              opacity: disabled ? 0.5 : 1,
            },
          },
          label,
        )

      return h(
        'section',
        {
          'data-dsh-qianfan-cookie-page': 'true',
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
            padding: '4px 2px',
            color: COLOR.text1,
            fontSize: '13px',
            lineHeight: '20px',
          },
        },
        h('p', { style: { margin: 0, color: COLOR.text2, fontSize: '12.5px' } }, COOKIE_TEXT.intro),
        h(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              padding: '12px',
              borderRadius: 'var(--dsw-radius-md, 10px)',
              boxShadow: 'inset 0 0 0 1px ' + COLOR.border,
            },
          },
          phase === 'loading' && status === null
            ? h('span', { style: { color: COLOR.text3, fontSize: '12px' } }, COOKIE_TEXT.loading)
            : h(KeyStatusLine, {
                configured,
                extra: masked === null ? source : (masked + ' · ' + (source ?? '')).trim(),
              }),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            input,
            action(busy ? COOKIE_TEXT.saving : COOKIE_TEXT.save, () => void submit('POST'), 'primary', busy || value.trim() === ''),
            configured ? action(busy ? COOKIE_TEXT.clearing : COOKIE_TEXT.clear, () => void submit('DELETE'), 'danger', busy) : null,
          ),
          notice === null
            ? null
            : h(
                'p',
                {
                  style: {
                    margin: 0,
                    fontSize: '12px',
                    color: notice.tone === 'danger'
                      ? COLOR.danger
                      : notice.tone === 'warn'
                        ? COLOR.warn
                        : COLOR.text2,
                  },
                },
                notice.text,
              ),
        ),
        h('p', { style: { margin: 0, color: COLOR.text3, fontSize: '11.5px' } }, COOKIE_TEXT.hint),
        h('p', { style: { margin: 0, color: COLOR.text3, fontSize: '11.5px' } }, COOKIE_TEXT.localOnly),
      )
    }

    /* ---------------------------------------------------------------- *
     * Plugin
     * ---------------------------------------------------------------- */

    function apply(ctx) {
      const slots = typeof ctx.get === 'function' ? ctx.get('slots') : undefined
      if (slots === undefined || slots === null) return
      slots.inject(SLOT, () =>
        slots.register(
          {
            name: SLOT,
            id: ENTRY_ID,
            order: 44,
            label: () => TEXT.title,
          },
          QianfanUsage,
        ),
      )
      // Entering a Cookie is a settings act, not something to hide behind the
      // reading's expander.
      slots.inject(SETTINGS_SLOT, () =>
        slots.register(
          {
            name: SETTINGS_SLOT,
            id: SETTINGS_ID,
            order: 61,
            label: () => COOKIE_TEXT.title,
          },
          QianfanCookiePage,
        ),
      )
    }

    module.exports.apply = apply
    module.exports.inject = ['slots']
    module.exports.QianfanUsage = QianfanUsage
    module.exports.QianfanCookiePage = QianfanCookiePage
    module.exports.parseReading = parseReading
    module.exports.summarize = summarize
    module.exports.formatAmount = formatAmount
    module.exports.formatCompact = formatCompact
    module.exports.formatPercent = formatPercent
    module.exports.formatCountdown = formatCountdown
    module.exports.toneOf = toneOf
    return module.exports
  },
})