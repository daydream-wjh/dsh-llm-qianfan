/**
 * Baidu Qianfan Token Plan provider route for the DeepSeek Harness LLM seam.
 *
 * Registers one `LlmAdapter`-shaped object for the `qianfan` provider route and
 * translates the harness message/stream vocabulary to Qianfan's OpenAI-compatible
 * `chat/completions` wire format. The object is duck-typed rather than extending
 * `LlmAdapter`: this bundle ships no dependency on `@deepseek-ai/dsh-llm`, so it
 * resolves from a linked profile directory without touching the ASAR anchor.
 *
 * The Token Plan personal subscription exposes a dedicated gateway at
 * `/v2/tokenplan/personal`; its key is rejected by the general `/v2` endpoint
 * (`token_plan_person_api_key_not_allowed`) and vice versa, so the base URL and
 * the credential must always travel together.
 *
 * The adapter is duck-typed rather than extending `LlmAdapter`, but it honours
 * the same seam contract that the first-party and `dsh-opencode-go` routes do:
 * attribution headers on every wire request, typed `LlmError` codes so retry
 * policy and the UI can classify failures, a provider retry policy, live model
 * discovery through `registerModelDiscovery`, and a per-model output allowance
 * rather than one global cap.
 *
 * @module dsh-llm-qianfan
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { foldUsage, meterView, mountUsageRoutes } from './lib/usage-meter.js'

/** Plugin row name surfaced in logs and the plugin inventory. */
export const name = 'llm-qianfan'

/** The LLM seam must be mounted before this plugin can register a route. */
export const inject = ['llm']

const PROVIDER = 'qianfan'
const DISPLAY_NAME = 'Qianfan Token Plan'
const CREDENTIAL_REF = 'QIANFAN_API_KEY'
const DEFAULT_BASE_URL = 'https://qianfan.baidubce.com/v2/tokenplan/personal'
const DEFAULT_MODEL = 'deepseek-v4.1-flash'

/**
 * Attribution header value sent on every wire request.
 *
 * The seam contract requires adapters to identify themselves, and the launching
 * application may append its own suffix through `DSH_USER_AGENT_SUFFIX`. This
 * route reads that variable on each request instead of hard-coding one string,
 * so a white-label launcher is not silently overwritten. A value that is not an
 * RFC 9110 product token is rejected by the harness at launch, so no validation
 * is repeated here.
 */
function attributionHeaders() {
  const suffix = process.env.DSH_USER_AGENT_SUFFIX
  const base = 'deepseek-harness (+https://github.com/deepseek-ai/deepseek-harness)'
  return { 'user-agent': suffix === undefined || suffix === '' ? base : `${base} ${suffix}` }
}

/**
 * Cap one request's output allowance.
 *
 * Qianfan bills reasoning tokens against the same cap as visible text, and the
 * gateway rejects anything above 393216 on this gateway's models. A caller that
 * states no allowance gets the smaller of the model's advertised ceiling and
 * this route's default, so an unopinionated call cannot spend the whole context
 * on one reply.
 */
const DEFAULT_OUTPUT_ALLOWANCE = 32768

/**
 * Fallback ceiling for a model the static catalog does not describe.
 *
 * Not a shared ceiling: models on this gateway disagree (393216 for DeepSeek,
 * 131072 for GLM-5.x, 1048576 for ERNIE-5.5-Flash). Each catalog entry carries
 * its own limit; this constant only covers a model discovered from the live
 * listing but not yet added to the catalog.
 */
const GATEWAY_MAX_OUTPUT = 393216

/**
 * Provider retry policy mirroring the harness defaults, but with a longer
 * ceiling: Qianfan's scheduler pauses bursts and answers `429` with a
 * `Retry-After` measured in tens of seconds, which the 10s host default would
 * discard in favour of the local backoff.
 */
const RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 5,
  retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
  initialDelayMs: 500,
  maxDelayMs: 60_000,
  jitterRatio: 0.1,
})

/** How long one discovery reply is trusted before the endpoint is asked again. */
const DISCOVERY_TTL_MS = 5 * 60 * 1000

/**
 * Reasoning-effort ladders, one per model family, taken verbatim from each
 * vendor's own documentation — not inferred from probe results.
 *
 * Qianfan validates the field against a single wide enum
 * (`none|low|medium|high|xhigh|max`, observed from its 400 message) and then
 * lets the upstream model apply its own narrower ladder. The narrow ladders
 * are what the vendors publish; the wide enum is only the transport envelope.
 */

/**
 * DeepSeek — https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/
 *
 * The documented control surface is `{"reasoning_effort": "low/high/max"}`
 * with effort defaulting to `high` and thinking on by default. DeepSeek also
 * publishes a mapping table for values it accepts but folds: minimal→low,
 * medium→high, xhigh→high, ultra→max. Only the three canonical levels are
 * offered here so a caller cannot select a value that silently degrades.
 */
const DEEPSEEK_EFFORTS = [
  { id: 'low', name: 'Low', description: 'DeepSeek low effort.' },
  { id: 'high', name: 'High', description: 'DeepSeek default effort.' },
  { id: 'max', name: 'Max', description: 'DeepSeek maximum effort.' },
]

/** Vendor-stated default effort, keyed by the model that publishes it. */

/**
 * GLM-5.3 / GLM-5.3-Flash — https://docs.bigmodel.cn/cn/guide/capabilities/thinking
 *
 * "仅支持 max、high、low，其余输入将报错". Thinking cannot be disabled on
 * these models; the vendor instructs callers to send `enabled` plus
 * `reasoning_effort: low` instead of `disabled`.
 */
const GLM53_EFFORTS = [
  { id: 'low', name: 'Low', description: 'GLM-5.3 light reasoning.' },
  { id: 'high', name: 'High', description: 'GLM-5.3 enhanced reasoning.' },
  { id: 'max', name: 'Max', description: 'GLM-5.3 deep reasoning (vendor default).' },
]

/**
 * GLM-5.2 — same page. Supports the full ladder; `none`/`minimal` mean the
 * model gives up thinking, `low`/`medium` fold to `high`, `xhigh` folds to
 * `max`. The distinct ids are kept because the vendor documents them as
 * accepted inputs rather than rejecting them.
 */
const GLM52_EFFORTS = [
  { id: 'none', name: 'None', description: 'GLM-5.2 gives up thinking.' },
  { id: 'minimal', name: 'Minimal', description: 'GLM-5.2 gives up thinking.' },
  { id: 'low', name: 'Low', description: 'GLM-5.2 light; folds to high upstream.' },
  { id: 'medium', name: 'Medium', description: 'GLM-5.2 medium; folds to high upstream.' },
  { id: 'high', name: 'High', description: 'GLM-5.2 enhanced reasoning.' },
  { id: 'xhigh', name: 'XHigh', description: 'GLM-5.2 extra-high; folds to max upstream.' },
  { id: 'max', name: 'Max', description: 'GLM-5.2 deep reasoning (vendor default).' },
]

/**
 * GLM-5.1 — the vendor scopes `reasoning_effort` to "GLM-5.2 and above", so
 * this model publishes no effort ladder of its own. Only its thinking switch
 * is documented; the effort list stays empty and the route rejects any
 * explicit effort rather than inventing levels.
 */
const GLM51_EFFORTS = []

/**
 * ERNIE-5.5-Flash-Preview — https://cloud.baidu.com/doc/qianfan-docs/s/Wm95lyynv
 * "默认为 high，取值范围为 low、medium、high".
 */
const ERNIE55_EFFORTS = [
  { id: 'low', name: 'Low', description: 'ERNIE 5.5 Flash low effort.' },
  { id: 'medium', name: 'Medium', description: 'ERNIE 5.5 Flash medium effort.' },
  { id: 'high', name: 'High', description: 'ERNIE 5.5 Flash high effort (default).' },
]

/**
 * ERNIE-Light-DT-1.0 — same page. "默认值为 max，取值范围为 low、high、max":
 * note the default is max here, unlike every other model on this gateway.
 */
const ERNIELIGHT_EFFORTS = [
  { id: 'low', name: 'Low', description: 'ERNIE Light DT low effort.' },
  { id: 'high', name: 'High', description: 'ERNIE Light DT high effort.' },
  { id: 'max', name: 'Max', description: 'ERNIE Light DT max effort (default).' },
]

/** Catalog advertised to catalog-driven surfaces (the GUI model picker). */
const CATALOG = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1441792, maxTokens: 393216, images: true, efforts: DEEPSEEK_EFFORTS, defaultEffort: 'high' },
  { id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash 1017', contextWindow: 1441792, maxTokens: 393216, images: true, efforts: DEEPSEEK_EFFORTS, defaultEffort: 'high' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1441792, maxTokens: 393216, efforts: DEEPSEEK_EFFORTS, defaultEffort: 'high' },
  { id: 'deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro 0813', contextWindow: 1441792, maxTokens: 393216, efforts: DEEPSEEK_EFFORTS, defaultEffort: 'high' },
  { id: 'deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash 0731', contextWindow: 1441792, maxTokens: 393216, efforts: DEEPSEEK_EFFORTS, defaultEffort: 'high' },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1179648, maxTokens: 131072, efforts: GLM53_EFFORTS, defaultEffort: 'max', thinkingAlwaysOn: true },
  { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', contextWindow: 1179648, maxTokens: 131072, images: true, efforts: GLM53_EFFORTS, defaultEffort: 'max', thinkingAlwaysOn: true },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1179648, maxTokens: 131072, efforts: GLM52_EFFORTS, defaultEffort: 'max' },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 333824, maxTokens: 131072, efforts: GLM51_EFFORTS },
  { id: 'ernie-5.5-flash-preview', name: 'ERNIE 5.5 Flash Preview', contextWindow: 2097152, maxTokens: 1048576, efforts: ERNIE55_EFFORTS, defaultEffort: 'high' },
  { id: 'ernie-light-dt-1.0', name: 'ERNIE Light DT 1.0', contextWindow: 1179648, maxTokens: 131072, efforts: ERNIELIGHT_EFFORTS, defaultEffort: 'max' },
]

/**
 * Output cap materialized when a caller omits `maxTokens`.
 *
 * Qianfan's reasoning models bill `reasoning_tokens` against `max_tokens`, so a
 * small cap can be spent entirely on thinking and return empty visible text.
 * Measured on deepseek-v4.1-flash through the Token Plan gateway: a 32-token cap
 * with thinking enabled returned only `reasoning_content` and empty `content`.
 */
const DEFAULT_MAX_TOKENS = 32768

/**
 * Models whose `thinking` switch only accepts `enabled`.
 *
 * Derived from the catalog: GLM-5.3 and GLM-5.3-Flash use forced thinking, and
 * the vendor says sending `disabled` errors out. The gateway does not actually
 * reject it (it silently ignores the field), so the request must omit it —
 * otherwise the harness would believe reasoning had been switched off.
 */
const THINKING_ALWAYS_ON = new Set(CATALOG.filter(entry => entry.thinkingAlwaysOn === true).map(entry => entry.id))

/**
 * Split a credentials YAML `refs` block into key/value pairs.
 *
 * The harness credentials file stores flat `KEY: 'value'` entries under `refs`.
 * A full YAML parser is not worth a dependency here, and the layout is stable:
 * two-space indent, one key per line, optionally single-quoted value.
 * @param {string} text - raw credentials file contents.
 * @returns {Map<string, string>} resolved refs, values unquoted.
 */
function parseCredentialRefs(text) {
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
    if (value.length >= 2 && (value.startsWith("'") || value.startsWith('"'))) {
      value = value.slice(1, -1)
    }
    if (value.length > 0) refs.set(match[1], value)
  }
  return refs
}

/**
 * Resolve the API key from, in order: the row config, the launching environment,
 * then the harness credentials file.
 * @param {{ apiKey?: string, credentialsFile?: string }} config - row config.
 * @returns {string} the trimmed credential.
 * @throws Error when no usable credential is available.
 */
function resolveApiKey(config) {
  const candidates = []
  if (typeof config.apiKey === 'string' && config.apiKey.trim() !== '') candidates.push(config.apiKey.trim())
  const fromEnv = process.env[CREDENTIAL_REF]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') candidates.push(fromEnv.trim())
  const file = typeof config.credentialsFile === 'string' && config.credentialsFile !== ''
    ? config.credentialsFile
    : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml')
  try {
    const stored = parseCredentialRefs(readFileSync(file, 'utf8')).get(CREDENTIAL_REF)
    if (stored !== undefined && stored.trim() !== '') candidates.push(stored.trim())
  } catch {
    // A missing or unreadable credentials file is not an error on its own; the
    // final throw below names every place the key could have come from.
  }
  const key = candidates[0]
  if (key === undefined) {
    throw new Error(
      `llm-qianfan: no credential for provider route "${PROVIDER}"; set the row's apiKey,`
      + ` export ${CREDENTIAL_REF}, or store ${CREDENTIAL_REF} in ${file} under refs`,
    )
  }
  return key
}

/** Join a base URL and a path without doubling or dropping the separator. */
function endpointOf(baseURL, path) {
  return `${baseURL.replace(/\/+$/, '')}${path}`
}

/**
 * Flatten harness content blocks into plain text.
 * @param {readonly { type: string, text?: string }[]} content - model-facing blocks.
 * @returns {string} concatenated text, with non-text blocks dropped.
 */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text')
    .map(block => block.text ?? '')
    .join('')
}

/**
 * Project one harness message to the Qianfan wire message, or to nothing when it
 * carries no wire-representable content.
 * @param {any} message - one `RequestMessage`.
 * @returns {object | null} a wire message, or null to omit it.
 */
function toWireMessage(message) {
  const role = message.role
  if (role === 'system') {
    const text = textOf(message.content)
    return text === '' ? null : { role: 'system', content: text }
  }
  if (role === 'developer') {
    // Developer messages carry tool-addition/removal bookkeeping. This route
    // declares no `toolUpdate` mode, so every request already sends the full
    // tool list and only any literal text is forwarded.
    const text = textOf(message.content)
    return text === '' ? null : { role: 'system', content: text }
  }
  if (role === 'user') {
    const text = textOf(message.content)
    return text === '' ? null : { role: 'user', content: text }
  }
  if (role === 'assistant') {
    const text = textOf(message.content)
    const calls = (message.content ?? []).filter(block => block.type === 'tool-call')
    const wire = { role: 'assistant', content: text }
    if (calls.length > 0) {
      wire.tool_calls = calls.map(call => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments === '' ? '{}' : call.arguments },
      }))
    }
    return wire.tool_calls === undefined && text === '' ? null : wire
  }
  if (role === 'tool') {
    const callId = message.toolCallId ?? message.source?.callId
    if (typeof callId !== 'string' || callId === '') return null
    return { role: 'tool', tool_call_id: callId, content: textOf(message.content) }
  }
  return null
}

/**
 * Build the Qianfan request body for one harness request.
 * @param {any} options - `GenerateOptions` from the LLM seam.
 * @param {object} config - row config.
 * @returns {object} the JSON body.
 */
function buildBody(options, config) {
  const messages = []
  if (typeof options.system === 'string' && options.system !== '') {
    messages.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages ?? []) {
    const wire = toWireMessage(message)
    if (wire !== null) messages.push(wire)
  }
  const body = {
    model: options.model,
    messages,
    stream: true,
  }
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools
      .filter(tool => tool.deferLoading !== true)
      .map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description ?? '',
          parameters: tool.parameters ?? { type: 'object', properties: {} },
        },
      }))
    if (body.tools.length === 0) delete body.tools
  }
  const allowance = outputAllowanceOf(options.model, options.maxTokens)
  if (allowance !== undefined) body.max_tokens = allowance
  if (typeof options.temperature === 'number') body.temperature = options.temperature
  if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop
  // `reasoning_effort` and `thinking` are independent axes on Qianfan:
  // effort controls how deep the reasoning runs, `thinking.type` merely
  // switches the reasoning pass on or off. Conflating them (mapping `low` to
  // `disabled`) silently strips reasoning from a model that defaults to on.
  if (typeof options.reasoningEffort === 'string' && options.reasoningEffort !== '') {
    body.reasoning_effort = options.reasoningEffort
  }
  const alwaysOn = THINKING_ALWAYS_ON.has(options.model)
  if (config.thinking === 'disabled' && !alwaysOn) {
    body.thinking = { type: 'disabled' }
  } else if (config.thinking === 'enabled') {
    body.thinking = { type: 'enabled' }
  }
  return body
}

/** Map a Qianfan `finish_reason` to the harness finish vocabulary. */
function finishOf(reason, sawToolCall) {
  if (reason === 'tool_calls' || sawToolCall) return { kind: 'tool-calls' }
  if (reason === 'length' || reason === 'max_tokens') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

/**
 * Live model directory, as last read from the gateway.
 *
 * The Token Plan `/models` endpoint returns only `id`/`object`/`owned_by`, so it
 * cannot replace the static catalog for sizing or effort ladders. It can still
 * answer the one question the static catalog gets wrong over time: which ids the
 * gateway accepts right now. A model that has been retired therefore disappears
 * from discovery, and a newly launched one appears without a plugin release.
 */
function createDiscovery(configOf) {
  let cached = null
  let cachedAt = 0

  /** Read the gateway listing, tolerating the terse Token Plan shape. */
  async function readListing(baseURL, apiKey, signal) {
    const response = await fetch(endpointOf(baseURL, '/models'), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...attributionHeaders(),
      },
      ...signal === undefined ? {} : { signal },
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status}${detail === '' ? '' : `: ${detail.slice(0, 300)}`}`)
    }
    const body = await response.json()
    const rows = Array.isArray(body?.data) ? body.data : []
    const ids = []
    for (const row of rows) {
      const id = typeof row?.id === 'string' ? row.id.trim() : ''
      if (id !== '' && !ids.includes(id)) ids.push(id)
    }
    if (ids.length === 0) throw new Error('the listing carried no model ids')
    return ids
  }

  return {
    /**
     * Answer one discovery request.
     *
     * A route this adapter already owns answers from the static catalog plus the
     * live listing, so the settings surface offers exactly what the gateway will
     * accept. An endpoint the caller is drafting is interrogated directly with
     * the one-shot credential the request carries.
     * @param request - endpoint or route under interrogation.
     * @param signal - caller cancellation.
     * @returns advertised models in listing order, enriched from the catalog.
     */
    async discover(request, signal) {
      const config = configOf()
      const baseURL = typeof request.baseURL === 'string' && request.baseURL !== ''
        ? request.baseURL
        : typeof config.baseURL === 'string' && config.baseURL !== '' ? config.baseURL : DEFAULT_BASE_URL
      // A draft may arrive before a credential is stored; ask the saved one only
      // for our own route, so a foreign endpoint is never sent our paid key.
      const apiKey = typeof request.apiKey === 'string' && request.apiKey !== ''
        ? request.apiKey
        : request.provider === PROVIDER ? resolveApiKey(config) : undefined
      if (apiKey === undefined) {
        throw new Error('model discovery needs a credential for this endpoint; enter one, or store QIANFAN_API_KEY')
      }

      const now = Date.now()
      const reuse = cached !== null && now - cachedAt < DISCOVERY_TTL_MS
      const ids = reuse && cached.baseURL === baseURL ? cached.ids : await readListing(baseURL, apiKey, signal)
      cached = { baseURL, ids }
      cachedAt = now

      return ids.map((id) => {
        const entry = CATALOG.find(candidate => candidate.id === id)
        return {
          id,
          ...entry === undefined ? {} : { name: entry.name },
          ...entry === undefined ? {} : { contextWindow: entry.contextWindow },
          ...entry === undefined ? {} : { maxTokens: entry.maxTokens },
          inputModalities: entry?.images === true ? ['text', 'image'] : ['text'],
        }
      })
    },

    /** Drop the cached listing so the next discovery asks again. */
    invalidate() {
      cached = null
      cachedAt = 0
    },
  }
}

/**
 * Classify one HTTP status into a seam failure code.
 *
 * An unclassified status becomes `HTTP_<n>`, which the retry policy can still
 * name; the mapped codes are the ones the harness treats specially, and getting
 * them wrong changes behaviour rather than wording — `RATE_LIMIT` is retried
 * with the provider's own `Retry-After`, while `AUTH` is not retried at all.
 * @param status - provider HTTP status.
 * @returns the stable code for this status.
 */
function failureCodeOf(status) {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 408) return 'TIMEOUT'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * Read a provider `Retry-After` header as milliseconds.
 *
 * Qianfan sends both the delta-seconds and the HTTP-date form. Anything
 * unparsable is dropped rather than guessed, because a wrong long delay would
 * stall the retry loop on a request that was never rate limited.
 * @param headers - response headers.
 * @returns the delay in milliseconds, or undefined when absent or invalid.
 */
function retryAfterMsOf(headers) {
  const raw = headers.get('retry-after')
  if (raw === null || raw.trim() === '') return undefined
  const seconds = Number(raw.trim())
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000)
  const at = Date.parse(raw)
  if (!Number.isNaN(at)) {
    const delta = at - Date.now()
    return delta > 0 ? delta : undefined
  }
  return undefined
}

/**
 * Build a typed seam failure.
 *
 * The harness shares one error taxonomy across providers; a plain `Error` loses
 * that classification, so a 429 would neither be retried nor shown as rate
 * limiting. A duck-typed adapter cannot import `LlmError`, so the shape is
 * reproduced: `code`, `failure`, `status`, `providerRetryAfterMs`.
 * @param message - non-empty human-readable summary.
 * @param code - stable seam failure code.
 * @param extra - optional provider facts.
 * @returns the error to throw.
 */
function seamError(message, code, extra = {}) {
  const error = new Error(message)
  error.name = 'LlmError'
  error.code = code
  error.failure = Object.freeze({
    message,
    code,
    ...extra.status === undefined ? {} : { status: extra.status },
    ...extra.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: extra.providerRetryAfterMs },
    ...extra.requestId === undefined ? {} : { requestId: extra.requestId },
  })
  if (extra.status !== undefined) error.status = extra.status
  if (extra.providerRetryAfterMs !== undefined) error.providerRetryAfterMs = extra.providerRetryAfterMs
  return error
}

/**
 * Clamp one request's output allowance.
 *
 * The caller's explicit value wins, because a caller that states a cap has a
 * reason. The route only fills in a default when none was given, and never lets
 * a value past that model's own ceiling — which would fail the whole request
 * with `parameter check failed, max_tokens range is [1, <ceiling>]`.
 * @param model - model id whose ceiling applies.
 * @param requested - caller's allowance, when stated.
 * @returns the allowance to send, or undefined to leave the field out.
 */
function outputAllowanceOf(model, requested) {
  const entry = CATALOG.find(candidate => candidate.id === model)
  // Each model publishes its own ceiling (ERNIE-5.5 allows 1M, GLM-5.x 128k);
  // the gateway-wide constant is only the fallback for a model the catalog does
  // not describe yet, because clamping every model to the smallest ceiling would
  // silently rob the large ones of their allowance.
  const ceiling = entry?.maxTokens ?? GATEWAY_MAX_OUTPUT
  if (typeof requested === 'number' && requested > 0) return Math.min(requested, ceiling)
  return Math.min(DEFAULT_OUTPUT_ALLOWANCE, ceiling)
}

/**
 * Build the adapter object registered for the `qianfan` route.
 * @param {() => object} configOf - reads the current row config.
 * @param {{ onUsage?: (usage: object) => void }} [hooks] - optional observation
 *   hook: the usage readout folds each report into its own plan windows. It is
 *   a side channel only — the adapter's emitted events are unchanged by it.
 * @returns {object} an `LlmAdapter`-shaped object.
 */
function createAdapter(configOf, hooks = {}) {
  return {
    providerInfo(provider) {
      return { id: provider, name: DISPLAY_NAME }
    },

    /**
     * Provider-owned retry policy.
     *
     * Returning a policy rather than `undefined` matters for rate limiting:
     * Qianfan pauses bursts and answers `429` with a `Retry-After` of tens of
     * seconds, and the policy's longer `maxDelayMs` lets the retry plugin honour
     * that instead of discarding it in favour of a local 10s backoff.
     * @returns the resolved policy for this route.
     */
    providerRetryPolicy() {
      return RETRY_POLICY
    },

    /** No provider-side image pricing: this route declares text-only input. */
    imageRequestPricing() {
      return undefined
    },

    /** Preserve normalized image dimensions; images never reach this wire. */
    imageRequestTarget(_provider, _model, image) {
      return { width: image.width, height: image.height, maxBytes: image.bytes }
    },

    async listModels(provider) {
      return CATALOG.map(entry => ({
        provider,
        id: entry.id,
        name: entry.name,
        inputModalities: entry.images === true ? ['text', 'image'] : ['text'],
      }))
    },

    async resolveModel(provider, model) {
      const entry = CATALOG.find(candidate => candidate.id === model)
      return {
        provider,
        id: model,
        name: entry?.name ?? model,
        inputModalities: entry?.images === true ? ['text', 'image'] : ['text'],
        context: { contextWindow: entry?.contextWindow ?? 128000 },
        defaultMaxTokens: DEFAULT_MAX_TOKENS,
        // Effort ladders are per model family, per each vendor's own docs.
        // A model with no documented ladder (GLM-5.1) declares none, which makes
        // the seam reject an explicit effort instead of accepting an invented one.
        ...entry?.efforts === undefined || entry.efforts.length === 0
          ? {}
          : {
              reasoning: {
                efforts: entry.efforts,
                defaultEffort: entry.defaultEffort,
              },
            },
      }
    },

    /**
     * Bind exact model metadata and the request dispatch to one generation, so
     * a settings change between preparation and dispatch cannot pair one
     * generation's capabilities with another's endpoint.
     */
    async prepareCall(provider, model, signal) {
      const modelInfo = await this.resolveModel(provider, model, signal)
      return { model: modelInfo, stream: options => this.stream(options) }
    },

    async *stream(options) {
      const config = configOf()
      const apiKey = resolveApiKey(config)
      const baseURL = typeof config.baseURL === 'string' && config.baseURL !== '' ? config.baseURL : DEFAULT_BASE_URL
      const body = buildBody(options, config)

      let response
      try {
        response = await fetch(endpointOf(baseURL, '/chat/completions'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            Authorization: `Bearer ${apiKey}`,
            ...attributionHeaders(),
          },
          body: JSON.stringify(body),
          ...options.signal === undefined ? {} : { signal: options.signal },
        })
      } catch (error) {
        // A caller cancellation is not a provider failure: end the stream
        // quietly so the harness reports an abort rather than a transport error.
        if (options.signal?.aborted === true) return
        throw seamError(`llm-qianfan: transport failed: ${error.message}`, 'TRANSPORT', { cause: error })
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        const requestId = response.headers.get('x-request-id') ?? undefined
        const retryAfter = retryAfterMsOf(response.headers)
        throw seamError(
          `llm-qianfan: provider returned HTTP ${response.status}${detail === '' ? '' : `: ${detail.slice(0, 500)}`}`,
          failureCodeOf(response.status),
          {
            status: response.status,
            ...retryAfter === undefined ? {} : { providerRetryAfterMs: retryAfter },
            ...requestId === undefined || requestId === '' ? {} : { requestId },
          },
        )
      }
      if (response.body === null) {
        throw seamError('llm-qianfan: provider returned an empty body', 'MALFORMED_RESPONSE', { status: response.status })
      }

      /** Accumulated emitted blocks, in emission order. */
      const blocks = []
      let reasoningBlock = null
      let textBlock = null
      const toolBlocks = new Map()
      let usage = null
      let finishReason = 'stop'
      let sawToolCall = false

      /** Open one block and announce it. */
      const openBlock = (blockType) => {
        const index = blocks.length
        const block = { index, type: blockType, text: '', id: undefined, name: undefined, args: '' }
        blocks.push(block)
        return block
      }

      const decoder = new TextDecoder()
      let buffer = ''
      const stream = response.body.getReader()

      try {
        while (true) {
          const { value, done } = await stream.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let newline = buffer.indexOf('\n')
          while (newline !== -1) {
            const raw = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            newline = buffer.indexOf('\n')
            if (!raw.startsWith('data:')) continue
            const payload = raw.slice(5).trim()
            if (payload === '' || payload === '[DONE]') continue

            let chunk
            try {
              chunk = JSON.parse(payload)
            } catch {
              continue
            }
            if (chunk.usage) usage = chunk.usage
            const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined
            if (choice === undefined) continue
            if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
              finishReason = choice.finish_reason
            }
            const delta = choice.delta
            if (delta === undefined || delta === null) continue

            if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
              if (reasoningBlock === null) {
                reasoningBlock = openBlock('reasoning')
                yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
              }
              reasoningBlock.text += delta.reasoning_content
              yield { type: 'reasoning-delta', index: reasoningBlock.index, text: delta.reasoning_content }
            }

            if (typeof delta.content === 'string' && delta.content !== '') {
              if (textBlock === null) {
                textBlock = openBlock('text')
                yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
              }
              textBlock.text += delta.content
              yield { type: 'text-delta', index: textBlock.index, text: delta.content }
            }

            if (Array.isArray(delta.tool_calls)) {
              for (const call of delta.tool_calls) {
                const key = typeof call.index === 'number' ? call.index : 0
                let target = toolBlocks.get(key)
                if (target === undefined) {
                  sawToolCall = true
                  target = openBlock('tool-call')
                  target.id = call.id ?? `tool_${key}`
                  target.name = ''
                  toolBlocks.set(key, target)
                  yield {
                    type: 'block-start',
                    index: target.index,
                    blockType: 'tool-call',
                  }
                }
                if (typeof call.id === 'string' && call.id !== '') target.id = call.id
                const nameDelta = typeof call.function?.name === 'string' ? call.function.name : ''
                const argumentDelta = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
                // Function names arrive whole on the first delta of a call; later
                // deltas either omit them or repeat the same value, so accumulate
                // only the transitions instead of concatenating duplicates.
                if (nameDelta !== '' && nameDelta !== target.name) {
                  target.name = target.name === '' ? nameDelta : target.name + nameDelta
                }
                target.args += argumentDelta
                yield {
                  type: 'tool-call-delta',
                  index: target.index,
                  id: target.id,
                  ...nameDelta === '' ? {} : { name: nameDelta },
                  argumentsDelta: argumentDelta,
                }
              }
            }
          }
        }
      } finally {
        stream.releaseLock()
      }

      // Close every open block in emission order, then account for usage and finish.
      for (const block of blocks) {
        if (block.type === 'reasoning') {
          yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
        } else if (block.type === 'text') {
          yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
        } else if (block.type === 'tool-call') {
          yield {
            type: 'block-end',
            index: block.index,
            block: {
              type: 'tool-call',
              id: block.id,
              name: block.name ?? '',
              arguments: block.args === '' ? '{}' : block.args,
            },
          }
        }
      }

      if (usage !== null) {
        const prompt = Number(usage.prompt_tokens ?? 0)
        const completion = Number(usage.completion_tokens ?? 0)
        const reasoningTokens = Number(usage.completion_tokens_details?.reasoning_tokens ?? 0)
        // Qianfan reports `prompt_tokens` as the WHOLE prompt and breaks the
        // cached share out separately. The harness vocabulary is disjoint:
        // `inputTokens` means uncached input only, and `cacheReadTokens` /
        // `cacheWriteTokens` are added on top of it. Passing `prompt_tokens`
        // straight through therefore double-counts the cached prefix — the UI
        // then divides cache reads by a prompt that already contains them and
        // the session reports a permanently cold cache. Subtract instead.
        const cacheRead = Number(
          usage.prompt_tokens_details?.cached_tokens
            ?? usage.prompt_cache_hit_tokens
            ?? usage.cached_tokens
            ?? 0,
        )
        const inputTokens = Math.max(0, prompt - cacheRead)
        const reported = {
          inputTokens,
          outputTokens: completion,
          totalTokens: Number(usage.total_tokens ?? prompt + completion),
          ...reasoningTokens > 0 ? { reasoningTokens } : {},
          ...cacheRead > 0 ? { cacheReadTokens: cacheRead } : {},
        }
        // Observed before it is yielded, so the readout's window total includes
        // the request the user is watching. A throwing hook must not break the
        // stream: the meter is diagnostics, the response is the product.
        try {
          hooks.onUsage?.(reported)
        } catch {
          // ignored on purpose — see above
        }
        yield { type: 'usage', usage: reported }
      }

      // A completion that produced neither visible text nor a tool call ends the
      // turn with nothing for the user or the loop to act on. Two causes are
      // distinct and must not be treated alike:
      //
      //  - `length`: the allowance was consumed entirely by reasoning. That is an
      //    allowance problem the caller can fix, and retrying the same request
      //    would only burn the same tokens again — so it is reported as
      //    `EMPTY_RESPONSE` *without* being retryable, and the message names the
      //    cap so the fix is obvious.
      //  - anything else: a degenerate completion the provider still billed.
      //    Repeating it is safe, so it carries the retryable code.
      if (textBlock === null && toolBlocks.size === 0 && usage !== null) {
        const reasoningSpent = Number(usage.completion_tokens_details?.reasoning_tokens ?? 0)
        const cap = body.max_tokens ?? DEFAULT_OUTPUT_ALLOWANCE
        throw seamError(
          reasoningSpent > 0
            ? `llm-qianfan: the ${cap}-token output allowance was spent entirely on reasoning`
              + ` (${reasoningSpent} reasoning tokens); raise maxTokens or lower reasoningEffort`
            : 'llm-qianfan: the provider returned no content blocks',
          finishReason === 'length' ? 'CONTEXT_WINDOW_EXCEEDED' : 'EMPTY_RESPONSE',
        )
      }

      yield { type: 'finish', reason: finishOf(finishReason, sawToolCall) }
    },
  }
}

/**
 * Mount the provider route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - row config: `{ apiKey?, baseURL?, credentialsFile? }`.
 */
export function apply(ctx, config) {
  const rowConfig = config ?? {}
  const configOf = () => rowConfig
  const discovery = createDiscovery(configOf)

  // The local half of the usage readout: every `usage` event the adapter yields
  // is folded into the plan's own windows, so the card can report what this
  // machine spent even when no console Cookie is configured. Holds only the
  // last month of samples, so it never grows with the process.
  let meterState = null
  const onUsage = (usage) => {
    meterState = foldUsage(meterState, usage, Date.now())
  }

  const adapter = createAdapter(configOf, { onUsage })
  const settingsNs = ctx.fiber?.entry?.options?.id ?? name

  // Registration is fiber-scoped: the LLM seam releases the route when this
  // plugin row unloads, so no explicit disposer is needed here.
  ctx.llm.registerAdapter([PROVIDER], adapter)
  // Advertise the route in configuration surfaces alongside its live state.
  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: DISPLAY_NAME,
      settingsNs,
      settingsPath: [],
      defaultBaseURL: DEFAULT_BASE_URL,
    },
  ])

  // The usage card needs a Web server to answer from. A headless profile has
  // none, and the provider route must keep working there: the whole feature is
  // mounted inside an optional scope instead of in `inject`, so this plugin
  // stays active either way. `connection` is declared here because the routes
  // read its gate — reading a service from a context that never declared it
  // throws, and the routes would then answer 403 to every browser.
  if (typeof ctx.inject === 'function') {
    try {
      // `webServer` and `connection` gate the routes; `credentials` is nested
      // one level deeper because it is optional: a profile without a credential
      // store must still serve the readout (the local meter needs no store), it
      // only has to refuse the Cookie write with an explanation.
      ctx.inject(['webServer', 'connection'], (scope) => {
        const store = { value: undefined }
        try {
          scope.inject(['credentials'], (storeScope) => {
            store.value = storeScope.get('credentials')
            return () => {
              if (store.value === storeScope.get('credentials')) store.value = undefined
            }
          })
        } catch {
          // No credential service in this profile: the write path reports it.
        }
        try {
          mountUsageRoutes(scope, {
            configOf,
            meterOf: () => meterState,
            // Read from whichever scope declared it: a cross-context read throws.
            credentialsOf: () => store.value,
          })
        } catch (error) {
          ctx.logger?.warn?.(`llm-qianfan: usage readout not mounted: ${error.message}`)
        }
      })
    } catch (error) {
      ctx.logger?.warn?.(`llm-qianfan: usage readout scope failed: ${error.message}`)
    }
  }

  // Live model discovery, so the settings surface offers what the gateway
  // defensively: an older host without the seam method, or one that already has
  // a discovery for this namespace, must not take the provider route down with
  // it — the static catalog still answers `listModels` either way.
  if (typeof ctx.llm.registerModelDiscovery === 'function') {
    try {
      ctx.llm.registerModelDiscovery(settingsNs, (request, signal) => discovery.discover(request, signal))
    } catch (error) {
      ctx.logger?.warn?.(`llm-qianfan: not registering model discovery for "${settingsNs}": ${error.message}`)
    }
  }

  try {
    const key = resolveApiKey(rowConfig)
    ctx.logger?.info?.(`llm-qianfan: provider "${PROVIDER}" ready (default model ${DEFAULT_MODEL}, key ...${key.slice(-4)})`)
  } catch (error) {
    ctx.logger?.warn?.(`llm-qianfan: provider "${PROVIDER}" mounted without a usable credential: ${error.message}`)
  }
}
