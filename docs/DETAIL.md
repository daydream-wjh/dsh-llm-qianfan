# 百度千帆 Token Plan 通道

把百度智能云千帆的 Token Plan 个人版网关接成 DeepSeek Harness 的一个模型 provider 路由，名字是 `qianfan`。

## 能做什么

- 走千帆 Token Plan 专属的 OpenAI 兼容 `chat/completions` 接口，支持流式返回
- 转发深度思考内容（`reasoning_content` → harness 的 `reasoning` 块），并由 `thinking` 开关控制
- 转发工具调用（`tool_calls` ↔ harness 的 `tool-call` 块），千帆侧已验证 `finish_reason: tool_calls`
- 回报用量（`prompt_tokens_details.cached_tokens` 亦在响应里，暂只取总量）
- 在模型页登记 Token Plan 个人版当前开放的 chat 模型

## 模型清单（2026-11-27 由 `/v2/tokenplan/personal/models` 实测拉取）

| 模型 id | 上下文 | 输出上限 | 图片 |
|---|---|---|---|
| deepseek-v4.1-flash | 1,441,792 | 393,216 | 是（别名指向 1017 快照） |
| deepseek-v4.1-flash-1017 | 1,441,792 | 393,216 | 是 |
| deepseek-v4-pro | 1,441,792 | 393,216 | 否 |
| deepseek-v4-pro-0813 | 1,441,792 | 393,216 | 否 |
| deepseek-v4-flash-0731 | 1,441,792 | 393,216 | 否 |
| glm-5.3 | 1,179,648 | 131,072 | 否 |
| glm-5.3-flash | 1,179,648 | 131,072 | 是 |
| glm-5.2 | 1,179,648 | 131,072 | 否 |
| glm-5.1 | 333,824 | 131,072 | 否 |
| ernie-5.5-flash-preview | 2,097,152 | 1,048,576 | 否 |
| ernie-light-dt-1.0 | 1,179,648 | 131,072 | 否 |

`unlimited-ocr-2` 是文档解析多模态模型，不适合作为对话路由，未登记。

## 凭据从哪来

按顺序取第一个非空值：

1. 本插件行配置里的 `apiKey`
2. 环境变量 `QIANFAN_API_KEY`
3. `$DSH_HOME/.credentials.yaml` 里 `refs.QIANFAN_API_KEY`

默认走第 3 条，密钥不写进 profile 配置文件。

## 端点与 key 必须成对

| key 类型 | 正确端点 | 用错的报错 |
|---|---|---|
| Token Plan 个人版（`bce-v3/ALTAK...`） | `https://qianfan.baidubce.com/v2/tokenplan/personal` | `/v2` → `token_plan_person_api_key_not_allowed` |
| 通用按量 key | `https://qianfan.baidubce.com/v2` | 套餐端点 → 同类鉴权拒绝 |

`/v2/tokenplan/personal` 的模型白名单比通用端点窄：`deepseek-v3.2`、`ernie-4.5-turbo-128k` 这类在套餐下返回 403 `token_plan_person_model_not_supported`，只有上表模型可用。

## 怎么用

1. 在模型设置里选 `Qianfan Token Plan` 提供方的模型，或在 `agent-default-model` 行里写：

   ```yaml
   - id: agent-default-model
     config:
       provider: qianfan
       model: deepseek-v4.1-flash
       reasoningEffort: high
   ```

2. 直接提问即可。

## 思考强度：按各家官网档位表，逐模型配置

档位不在本插件里自造，全部取自各厂商自己的官方文档。**同一个 `reasoning_effort` 字段，各家支持的档位完全不同**，所以档位表是按模型声明的，不是全局一张表。

### 千帆网关的校验域（传输层）

网关本身只做一次宽松校验，越界才 400。实测错误消息给出了完整合法域：

```
parameter check failed, reasoning_effort must be none or low or medium or high or xhigh or max
```

这只是**传输信封**，不是各模型的真实档位表。模型会在自己的窄域内再做一次取舍。

### DeepSeek 系列（5 个模型共用）

来源：[DeepSeek 思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)

| 项 | 官方定义 |
|---|---|
| 控制参数 | `{"reasoning_effort": "low/high/max"}` |
| 默认 | `high`，思考模式默认打开 |
| 思考开关 | `{"thinking": {"type": "enabled/disabled"}}` 可关 |
| 折叠映射 | minimal→low、medium→high、xhigh→high、ultra→max |

本插件只暴露 `low`、`high`、`max` 三档，默认 `high`。折叠值（minimal/medium/xhigh/ultra）不暴露——它们是「传了也不报错、但会静默降级」的坑，暴露出去等于让调用方以为选到了更细的档。

### GLM-5.3 / GLM-5.3-Flash

来源：[智谱 深度思考](https://docs.bigmodel.cn/cn/guide/capabilities/thinking)

| 项 | 官方定义 |
|---|---|
| 档位 | **仅 max、high、low**，"其余输入将报错" |
| 默认 | `max`（"默认且推荐"） |
| 思考开关 | **不可关闭**。官方原话：传 `disabled` 将会报错，迁移时应改成 `enabled` + `reasoning_effort: low` |

注意官方原话是「传 disabled 将会报错」，但**千帆网关实测是静默忽略而非报错**（发 `thinking: disabled` 仍返回 `reasoning_tokens`）。所以插件直接不发该字段，避免上层误以为思考已关。

### GLM-5.2

同一文档。支持完整七档：`none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，默认 `max`。其中 `none`/`minimal` 代表**模型放弃思考**，`low`/`medium` 映射为 `high`，`xhigh` 映射为 `max`。这七档是官方明确列为可接受的输入，故全部保留。

### GLM-5.1

官方把 `reasoning_effort` 的范围限定为「仅 GLM-5.2 及以上支持」，因此 **GLM-5.1 没有档位表**。插件对它声明空档位集合，DSH seam 会直接拒绝对它设置 `reasoningEffort`，而不是编一个上去。

### ERNIE-5.5-Flash-Preview

来源：[千帆 深度思考](https://cloud.baidu.com/doc/qianfan-docs/s/Wm95lyynv)：默认 `high`，取值范围 `low`、`medium`、`high`。

### ERNIE-Light-DT-1.0

同一文档：**默认值为 `max`**，取值范围 `low`、`high`、`max`。注意这个模型是全场唯一默认 max 的（GLM 系也默认 max）。

### 汇总表（插件实际声明）

| 模型 | 档位 | 默认 |
|---|---|---|
| deepseek-v4.1-flash / -1017 / v4-pro / v4-pro-0813 / v4-flash-0731 | low, high, max | high |
| glm-5.3 / glm-5.3-flash | low, high, max | max |
| glm-5.2 | none, minimal, low, medium, high, xhigh, max | max |
| glm-5.1 | （无档位，设了会被拒） | — |
| ernie-5.5-flash-preview | low, medium, high | high |
| ernie-light-dt-1.0 | low, high, max | max |

## 已知限制

- DeepSeek 系列不支持 `temperature`、`top_p`、`presence_penalty`、`frequency_penalty`、`logprobs`、`top_logprobs`，设了不报错但不生效
- `thinking_budget`（思维链长度上限，最小 100）在官方支持清单里只有 `ernie-5.1`，不在本套餐模型内
- 推理 token 计入 `max_tokens`，上限设太小会只剩思考、正文为空（32 token 上限实测正文全空）
- 千帆的 Anthropic 兼容通道在 `https://qianfan.baidubce.com/anthropic/tokenplan/personal`，本插件不走它
- 模型清单是静态内置的，不调用 `/models` 自动发现
