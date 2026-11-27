# dsh-llm-qianfan

把百度智能云千帆 **Token Plan 个人版**网关接成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的一个模型 provider 路由，名字是 `qianfan`。走千帆的 OpenAI 兼容 `chat/completions` 接口，支持流式文本、深度思考、工具调用与用量统计。

> English docs: [README.md](./README.md)。

## 为什么端点写死成套餐专用

套餐 key 和按量 key 不能互换。套餐 key 打通用 `/v2` 会返回 `401 token_plan_person_api_key_not_allowed`，按量 key 打套餐端点同样失败。两者必须成对，所以本插件把 base URL 钉在套餐网关上，而不是做成自由填写：

| 凭据类型 | 唯一可用 base URL |
| --- | --- |
| Token Plan 个人版（`bce-v3/ALTAK...`） | `https://qianfan.baidubce.com/v2/tokenplan/personal` |
| 通用按量 | `https://qianfan.baidubce.com/v2` |

行配置仍接受 `baseURL` 覆盖，留给网关改名或企业席位的情况。

## 模型

套餐网关只开放一份窄白名单，白名单外的模型无论 key 是否有效都返回 `403 token_plan_person_model_not_supported`，所以目录里只登记网关真正接受的模型。

| 模型 id | 上下文 | 输出上限 | 图片 |
| --- | --- | --- | --- |
| `deepseek-v4.1-flash` | 1,441,792 | 393,216 | 支持 |
| `deepseek-v4.1-flash-1017` | 1,441,792 | 393,216 | 支持 |
| `deepseek-v4-pro` | 1,441,792 | 393,216 | 不支持 |
| `deepseek-v4-pro-0813` | 1,441,792 | 393,216 | 不支持 |
| `deepseek-v4-flash-0731` | 1,441,792 | 393,216 | 不支持 |
| `glm-5.3` | 1,179,648 | 131,072 | 不支持 |
| `glm-5.3-flash` | 1,179,648 | 131,072 | 支持 |
| `glm-5.2` | 1,179,648 | 131,072 | 不支持 |
| `glm-5.1` | 333,824 | 131,072 | 不支持 |
| `ernie-5.5-flash-preview` | 2,097,152 | 1,048,576 | 不支持 |
| `ernie-light-dt-1.0` | 1,179,648 | 131,072 | 不支持 |

上下文与输出上限取自千帆公开的 `/v2/models` 元数据。套餐自己的 `/models` 只返回 `id`、`object`、`owned_by`，不含任何规格信息。

## 思考强度按模型声明，不是全局一张表

`reasoning_effort` 是同一个字段名，但每个模型家族发布的档位不同。网关只做一次宽松校验，并在 400 消息里给出它接受的集合：

```
parameter check failed, reasoning_effort must be none or low or medium or high or xhigh or max
```

这是传输信封。真正的档位更窄，来自各家自己的文档：

| 模型 | 档位 | 默认 |
| --- | --- | --- |
| DeepSeek V4.x（五个） | `low`、`high`、`max` | `high` |
| `glm-5.3`、`glm-5.3-flash` | `low`、`high`、`max` | `max` |
| `glm-5.2` | `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` | `max` |
| `glm-5.1` | 无档位，显式设置会被拒 | — |
| `ernie-5.5-flash-preview` | `low`、`medium`、`high` | `high` |
| `ernie-light-dt-1.0` | `low`、`high`、`max` | `max` |

出处逐条引在代码对应常量上方：

- DeepSeek — <https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/>：`{"reasoning_effort": "low/high/max"}`，effort 默认 `high`，思考默认打开。DeepSeek 另有折叠表（minimal→low、medium→high、xhigh→high、ultra→max），这些折叠值**不暴露**，因为它们不报错、只静默降级。
- 智谱 — <https://docs.bigmodel.cn/cn/guide/capabilities/thinking>：GLM-5.3「仅接受 max、high、low，其余输入将报错」，默认 `max`，且不可关闭思考。GLM-5.2 接受全部七档。`reasoning_effort` 官方限定「GLM-5.2 及以上」，故 GLM-5.1 无档位。
- 千帆 — <https://cloud.baidu.com/doc/qianfan-docs/s/Wm95lyynv>：ERNIE-5.5-Flash-Preview 默认 `high`，取值 `low`/`medium`/`high`；ERNIE-Light-DT-1.0 默认 `max`，取值 `low`/`high`/`max`。

`glm-5.1` 声明空档位是刻意为之：DSH seam 会因此拒绝对它显式设置 `reasoningEffort`，而不是把编造的值转发给网关。

## 思考开关是另一根轴

`thinking.type`（`enabled`/`disabled`）决定要不要思考，`reasoning_effort` 决定想多深。把两者混为一谈，会让默认开启思考的模型丢掉整段推理。

`glm-5.3` 与 `glm-5.3-flash` 是强制思考。智谱文档说传 `disabled` 会报错，但本网关实测是静默忽略——所以对这两个模型根本不发 `thinking` 字段，避免上层误以为思考已关。

DeepSeek 的思考模型会忽略 `temperature`、`top_p`、`presence_penalty`、`frequency_penalty`、`logprobs`、`top_logprobs`：设了不报错，也不生效。

## 凭据来源

按顺序取第一个非空值：

1. 本插件行配置里的 `apiKey`
2. 环境变量 `QIANFAN_API_KEY`
3. `$DSH_HOME/.credentials.yaml` 里的 `refs.QIANFAN_API_KEY`

默认走第三条，密钥不必写进 profile 配置文件。

## 安装

```sh
dsh plugin --profile <name> add github:daydream-wjh/dsh-llm-qianfan
```

然后在 `$DSH_HOME/.credentials.yaml` 的 `refs` 下存一次 key：

```yaml
QIANFAN_API_KEY: 'bce-v3/ALTAK...'
```

设为默认模型则改 profile 的 `cordis.patch.yml`：

```yaml
- id: agent-default-model
  config:
    provider: qianfan
    model: deepseek-v4.1-flash
    reasoningEffort: high   # DeepSeek 文档给出的默认档
```

## 对齐 seam 契约

适配器是 duck-typed 的，但遵守与官方路由、`dsh-opencode-go` 相同的 seam 契约：

- **归属头部** —— 每个请求带 `user-agent: deepseek-harness/<version> (+url)`，并逐次读取 `DSH_USER_AGENT_SUFFIX`，不覆盖白标启动器的身份。
- **错误分类** —— 错误携带稳定的 `code`（`AUTH`、`RATE_LIMIT`、`SERVER`、`TRANSPORT`、`EMPTY_RESPONSE`、`CONTEXT_WINDOW_EXCEEDED` 等），以及提供方给出的 `status` 与 `providerRetryAfterMs`。
- **重试策略** —— provider 自有策略，`maxDelayMs` 提到 60 秒，让千帆的 `429` + `Retry-After` 生效，而不是被宿主 10 秒默认值丢掉。
- **动态发现** —— `registerModelDiscovery` 从网关列表作答（5 分钟缓存），并用静态目录补尺寸，配置界面因此拿到网关当前真正接受的 id。`unlimited-ocr-2` 就是被发现但静态目录未收录的例子。
- **按模型的输出上限** —— 各模型保留自己的 ceiling（ERNIE-5.5-Flash 1,048,576、GLM-5.x 131,072），调用方不指定时路由才用 32,768。
- **退化响应** —— 空完成会被报出，而不是静默产出一条空消息。`length` 结束归为 `CONTEXT_WINDOW_EXCEEDED` 且**不重试**，因为重发只会再烧一次同样的额度；其他空完成才归为可重试的 `EMPTY_RESPONSE`。

两种空完成成因刻意分开。同一条 `max_tokens: 50` 的请求实测：两次有内容，第三次 `finish=length` 且内容为空、思考吃掉 50 token。那是调用方可以修的额度问题，不是传输抖动。

发现只在请求自带 `apiKey`、或问的就是本路由时才发送已保存的 key——陌生 `baseURL` 拿不到付费凭据。

## 已知限制

- 推理 token 计入 `max_tokens`，上限设太小会只剩思考、正文为空。调用方不传 `maxTokens` 时插件物化 `32768`。
- 千帆文档提到 DeepSeek 思考模型支持 `thinking_budget`（思维链 32k），但 `100`/`500`/`32768` 三组实测的波动盖过了 budget 差，故本插件不发送该参数。
- 模型元数据是静态目录。套餐 `/models` 不返回能力数据，新上线的模型需要更新目录才会出现。

## 开发

适配器是 duck-typed 的，没有继承 `LlmAdapter`，因此包不依赖 `@deepseek-ai/dsh-llm`，可以直接从 link 的 profile 目录解析。

```sh
node --input-type=module -e "await import('./index.js')"   # 语法检查
```

## 许可

MIT