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
 * @module dsh-llm-qianfan
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
  if (typeof options.maxTokens === 'number' && options.maxTokens > 0) body.max_tokens = options.maxTokens
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
 * Build the adapter object registered for the `qianfan` route.
 * @param {() => object} configOf - reads the current row config.
 * @returns {object} an `LlmAdapter`-shaped object.
 */
function createAdapter(configOf) {
  return {
    providerInfo(provider) {
      return { id: provider, name: DISPLAY_NAME }
    },

    /**
     * The route declares no retry policy of its own; `undefined` keeps the
     * harness defaults. The seam calls this method directly, so a duck-typed
     * adapter must define it even when it has nothing to say.
     */
    providerRetryPolicy() {
      return undefined
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
            'User-Agent': 'deepseek-harness (+https://github.com/deepseek-ai/deepseek-harness)',
          },
          body: JSON.stringify(body),
          ...options.signal === undefined ? {} : { signal: options.signal },
        })
      } catch (error) {
        if (options.signal?.aborted === true) return
        throw error
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`llm-qianfan: provider returned HTTP ${response.status}${detail === '' ? '' : `: ${detail.slice(0, 500)}`}`)
      }
      if (response.body === null) throw new Error('llm-qianfan: provider returned an empty body')

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
        yield {
          type: 'usage',
          usage: {
            inputTokens: prompt,
            outputTokens: completion,
            totalTokens: Number(usage.total_tokens ?? prompt + completion),
            ...reasoningTokens > 0 ? { reasoningTokens } : {},
          },
        }
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
  const adapter = createAdapter(configOf)
  // Registration is fiber-scoped: the LLM seam releases the route when this
  // plugin row unloads, so no explicit disposer is needed here.
  ctx.llm.registerAdapter([PROVIDER], adapter)
  // Advertise the route in configuration surfaces alongside its live state.
  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: DISPLAY_NAME,
      settingsNs: ctx.fiber?.entry?.options?.id ?? name,
      settingsPath: [],
      defaultBaseURL: DEFAULT_BASE_URL,
    },
  ])
  try {
    const key = resolveApiKey(rowConfig)
    ctx.logger?.info?.(`llm-qianfan: provider "${PROVIDER}" ready (default model ${DEFAULT_MODEL}, key ...${key.slice(-4)})`)
  } catch (error) {
    ctx.logger?.warn?.(`llm-qianfan: provider "${PROVIDER}" mounted without a usable credential: ${error.message}`)
  }
}
