# dsh-llm-qianfan

Baidu Qianfan **Token Plan** provider route for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) LLM seam. Registers a `qianfan` provider that speaks Qianfan's OpenAI-compatible `chat/completions` API, with streaming text, reasoning blocks, tool calls and token usage.

> 中文说明见 [README.zh.md](./README.zh.md)。

## Why the Token Plan endpoint is hard-coded

A Token Plan personal key and a pay-as-you-go key are not interchangeable. A Token Plan key against the general `/v2` endpoint fails with `401 token_plan_person_api_key_not_allowed`, and a general key against the Token Plan endpoint fails the same way. The two must travel together, so this plugin pins the base URL to the Token Plan gateway instead of making it a free-form field:

| Credential | Only working base URL |
| --- | --- |
| Token Plan personal (`bce-v3/ALTAK...`) | `https://qianfan.baidubce.com/v2/tokenplan/personal` |
| Pay-as-you-go | `https://qianfan.baidubce.com/v2` |

The row config still accepts `baseURL` to override this, for a future gateway rename or an enterprise seat.

## Models

The Token Plan gateway serves a narrow allowlist. Any model outside it returns `403 token_plan_person_model_not_supported` regardless of key validity, so the catalog only lists models the gateway actually accepts.

| Model id | Context | Max output | Images |
| --- | --- | --- | --- |
| `deepseek-v4.1-flash` | 1,441,792 | 393,216 | yes |
| `deepseek-v4.1-flash-1017` | 1,441,792 | 393,216 | yes |
| `deepseek-v4-pro` | 1,441,792 | 393,216 | no |
| `deepseek-v4-pro-0813` | 1,441,792 | 393,216 | no |
| `deepseek-v4-flash-0731` | 1,441,792 | 393,216 | no |
| `glm-5.3` | 1,179,648 | 131,072 | no |
| `glm-5.3-flash` | 1,179,648 | 131,072 | yes |
| `glm-5.2` | 1,179,648 | 131,072 | no |
| `glm-5.1` | 333,824 | 131,072 | no |
| `ernie-5.5-flash-preview` | 2,097,152 | 1,048,576 | no |
| `ernie-light-dt-1.0` | 1,179,648 | 131,072 | no |

The context and max-output numbers come from Qianfan's public `/v2/models` metadata. The Token Plan `/models` endpoint returns only `id`, `object` and `owned_by`, so it carries no sizing information.

## Reasoning effort is per model, not global

`reasoning_effort` is one field name, but each model family publishes its own ladder. The gateway performs a single loose check and reports its accepted set in the 400 message:

```
parameter check failed, reasoning_effort must be none or low or medium or high or xhigh or max
```

That is the transport envelope. The real ladders are narrower and come from each vendor's documentation:

| Model | Ladder | Default |
| --- | --- | --- |
| DeepSeek V4.x (all five) | `low`, `high`, `max` | `high` |
| `glm-5.3`, `glm-5.3-flash` | `low`, `high`, `max` | `max` |
| `glm-5.2` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | `max` |
| `glm-5.1` | none declared — an explicit effort is rejected | — |
| `ernie-5.5-flash-preview` | `low`, `medium`, `high` | `high` |
| `ernie-light-dt-1.0` | `low`, `high`, `max` | `max` |

Sources, quoted in the code next to each constant:

- DeepSeek — <https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/>: `{"reasoning_effort": "low/high/max"}`, effort defaults to `high`, thinking defaults to on. DeepSeek also documents a fold table (minimal→low, medium→high, xhigh→high, ultra→max); those folded values are **not** exposed here, because they do not error — they silently degrade.
- Zhipu — <https://docs.bigmodel.cn/cn/guide/capabilities/thinking>: GLM-5.3 "only accepts max, high, low; other inputs will error", default `max`, thinking cannot be disabled. GLM-5.2 accepts all seven. `reasoning_effort` is scoped to "GLM-5.2 and above", so GLM-5.1 gets no ladder.
- Qianfan — <https://cloud.baidu.com/doc/qianfan-docs/s/Wm95lyynv>: ERNIE-5.5-Flash-Preview defaults to `high` with range `low`/`medium`/`high`; ERNIE-Light-DT-1.0 defaults to `max` with range `low`/`high`/`max`.

`glm-5.1` declaring an empty ladder is deliberate: the DSH seam then refuses an explicit `reasoningEffort` for that model instead of forwarding an invented value.

## Thinking switch is a separate axis

`thinking.type` (`enabled`/`disabled`) controls whether a reasoning pass happens at all; `reasoning_effort` controls how deep it runs. Conflating the two drops reasoning from models that default to on.

`glm-5.3` and `glm-5.3-flash` use forced thinking. Zhipu's documentation says sending `disabled` errors out, but this gateway silently ignores the field instead — so the request omits `thinking` for those two models rather than letting the caller believe reasoning was switched off.

DeepSeek's reasoning models ignore `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`, `logprobs` and `top_logprobs`: setting them does not error and does not take effect.

## Credential resolution

Checked in order, first non-empty wins:

1. this plugin row's `apiKey`
2. the `QIANFAN_API_KEY` environment variable
3. `refs.QIANFAN_API_KEY` in `$DSH_HOME/.credentials.yaml`

The default is the third, so the key does not have to live in a profile config file.

## Install

```sh
dsh plugin --profile <name> add github:daydream-wjh/dsh-llm-qianfan
```

Then store the key once:

```sh
# in $DSH_HOME/.credentials.yaml, under refs:
QIANFAN_API_KEY: 'bce-v3/ALTAK...'
```

To make it the default model, edit the profile's `cordis.patch.yml`:

```yaml
- id: agent-default-model
  config:
    provider: qianfan
    model: deepseek-v4.1-flash
    reasoningEffort: high   # DeepSeek's documented default
```

## Seam contract

The adapter is duck-typed, but it honours the same seam contract as the first-party and `dsh-opencode-go` routes:

- **Attribution** — every wire request carries `user-agent: deepseek-harness/<version> (+url)`, with `DSH_USER_AGENT_SUFFIX` read per request so a white-label launcher is not overwritten.
- **Typed failures** — errors carry a stable `code` from the harness taxonomy (`AUTH`, `RATE_LIMIT`, `SERVER`, `TRANSPORT`, `EMPTY_RESPONSE`, `CONTEXT_WINDOW_EXCEEDED`, …), plus `status` and `providerRetryAfterMs` when the provider supplied them.
- **Retry policy** — a provider-owned policy with a 60 s `maxDelayMs`, so Qianfan's `429` + `Retry-After` is honoured instead of being discarded by the 10 s host default.
- **Live discovery** — `registerModelDiscovery` answers from the gateway listing (5-minute cache) enriched with the static catalog, so the settings surface offers the ids the gateway accepts right now. `unlimited-ocr-2` is discovered but not in the static catalog, which is exactly the case discovery exists for.
- **Per-model output allowance** — each model keeps its own ceiling (1,048,576 for ERNIE-5.5-Flash, 131,072 for GLM-5.x), with the route defaulting to 32,768 only when a caller states none.
- **Degenerate replies** — an empty completion is reported rather than silently yielding an empty assistant message. A `length` finish is `CONTEXT_WINDOW_EXCEEDED` and is *not* retried, because repeating it would burn the same allowance again; any other empty completion is retryable `EMPTY_RESPONSE`.

Two empty-completion causes are deliberately separated. Measured on one request with `max_tokens: 50`: two attempts returned content, a third returned `finish=length` with empty content and 50 reasoning tokens. That is an allowance problem the caller can fix, not a transport flake.

Discovery sends the stored key only when the request carries its own `apiKey`, or when it asks about this provider's own route — a foreign `baseURL` never receives a paid credential.

## Usage readout

One row above the composer; expanding it shows two groups of numbers. **They come from different places and cannot substitute for each other.**

### Plan quota (the console's own numbers, needs a console Cookie)

Only the Baidu Cloud console answers "how much of the plan is left":

```
GET https://console.bce.baidu.com/api/qianfan/charge/tokenPlanPersonal/resource
```

**The inference API key cannot read the quota** — that is the server's shape, not a gap in this plugin: the key is answered with a 302 to the login page, and every `/v2/tokenplan/personal/{usage,quota,plan,balance,credits,…}` path returns 404. The console endpoint authenticates with the logged-in console.bce.baidu.com Cookie.

### Automatic refresh (launchd)

The Cookie is a browser session and it expires. A launchd job runs daily at 04:17, plus once at login:

```sh
tools/qianfan-cookie-install.sh   # install/update (re-run after changing the script)
launchctl kickstart -k gui/$(id -u)/io.dsh.qianfan-cookie   # trigger once now
tail /tmp/dsh-qianfan-refresh.out.log                       # see the result
```

Two properties make it safe: **verify before write** (a lapsed browser session can never replace a working credential), and **no write when unchanged** (a healthy day leaves the file alone, so the credentials store does not reload).

It runs from `~/.dsh/tools/`, not the repo: macOS TCC forbids background agents from reading `~/Documents`, and a job that cannot read its own script exits 126. The repository copy is the source; `install.sh` syncs it.

Paste it in the "Qianfan Token Plan" settings page, **via Copy as cURL**: sign in to the console and open "我的订阅" → DevTools Network → reload → pick the `tokenPlanPersonal/resource` request → right-click "Copy as cURL" → paste the whole command.

Why not just copy the Cookie value: the session ticket `BDUSS` is **HttpOnly**. `document.cookie` returns 34 cookies for the domain and none of them is `BDUSS`; neither the DevTools Application panel's value cell nor any page-side view of a request header carries it. Sending that whole non-HttpOnly set to the quota endpoint still answers `302` to the login page (measured). "Copy as cURL" is the one gesture in the browser that includes it, so the plugin accepts the command verbatim and extracts the `Cookie` header itself.

### Automatic extraction (macOS, needs a one-time grant)

The Cookie is a browser session and it expires. Besides pasting Copy as cURL in the settings page, a script can read it straight from Chrome's encrypted store:

```sh
tools/qianfan-refresh.sh            # extract, verify, save
tools/qianfan-refresh.sh --dry-run  # verify only
```

macOS guards Chrome's cookie database behind **Full Disk Access**: without it, `cp`, a Finder-mediated copy, and a copy run from inside Terminal.app all fail with `Operation not permitted`; with it, one run succeeds. Grant it under System Settings → Privacy & Security → Full Disk Access to the app that runs DSH, then restart DSH.

The script always probes the real endpoint before writing, so re-running it whenever the session expires is safe — it will not replace a working credential with a broken one. A cron entry works too.

It is stored as the `BAIDU_QIANFAN_COOKIE` credential, and the environment variable of that name works too. A save probes first: an expired login, or a header without `BDUSS`, is not written — otherwise the card would say "configured" beside a credential that always fails.

### Local meter (what this machine actually billed)

Every `usage` event the adapter emits is folded into the plan's own windows: 5 hours / this week / this month, counted the Token-mode way (input + output + cache — Qianfan does not separate cached tokens).

Its value is the fallback: with no Cookie it is the only number available; with one it says how much of the subscription this machine spent. It is **not** the console's used total, because the console counts every client.

| State | Card |
| --- | --- |
| No Cookie | says so; the local meter still renders |
| Cookie expired | says the login expired; the local meter still renders |
| No active plan | a lapsed plan is not dressed up as a spent one |

A failure on the official half never takes the local half down: the row does not disappear and never shows a fake zero.

## Known limits

- Reasoning tokens are billed against `max_tokens`, so a small cap can be consumed entirely by thinking and return empty visible text. The plugin materializes `32768` when a caller omits `maxTokens`.
- `thinking_budget` appears in Qianfan's documentation for DeepSeek thinking models (32k chain-of-thought), but measurements across `100`/`500`/`32768` did not separate from sample noise, so this plugin does not send it.
- Model metadata is a static catalog. The Token Plan `/models` endpoint returns no capability data, so a newly launched model does not appear until the catalog is updated.

## Development

The adapter is duck-typed rather than extending `LlmAdapter`, so the package carries no dependency on `@deepseek-ai/dsh-llm` and resolves from a linked profile directory.

```sh
node --input-type=module -e "await import('./index.js')"   # syntax check
npm test                                                   # 57 offline checks
```

Four suites under `verify/`: `usage-meter.test.mjs` (Cookie shape, time zone, both billing modes, window arithmetic), `route.test.mjs` (route contract and gate), `client.test.mjs` (render states), `apply.test.mjs` (`apply()` really registers the routes, and one real stream reaches the meter).

## License

MIT