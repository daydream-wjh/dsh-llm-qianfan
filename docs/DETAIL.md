# 百度千帆 Token Plan 通道

把百度智能云千帆的 Token Plan 个人版网关接成 DeepSeek Harness 的一个模型 provider 路由，名字是 `qianfan`。

## 能做什么

- 走千帆 Token Plan 专属的 OpenAI 兼容 `chat/completions` 接口，支持流式返回
- 转发深度思考内容（`reasoning_content` → harness 的 `reasoning` 块），并由 `thinking` 开关控制
- 转发工具调用（`tool_calls` ↔ harness 的 `tool-call` 块），千帆侧已验证 `finish_reason: tool_calls`
- 回报用量：`prompt_tokens` 折算成 harness 的互斥三元组——`prompt_tokens_details.cached_tokens` 拆出去当 `cacheReadTokens`，剩余的当 `inputTokens`；千帆的 `prompt_tokens` 是含缓存的全量，直接透传会导致缓存命中率恒为 0
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


## 对齐 DSH 官方 seam 契约（0.2.0，参照 dsh-opencode-go）

初版是 duck-typed 最小实现，把自家路由跑通了，但漏掉了几件事——它们不是锦上添花，是 seam 契约里写明或影响运行行为的：

| 项 | 初版 | 现在 | 为什么重要 |
|---|---|---|---|
| **归属头部** | 硬编码 UA 字符串 | `attributionHeaders()`，每次请求读 `DSH_USER_AGENT_SUFFIX` | 契约原话：「Every provider HTTP request must include `attributionHeaders()`」。硬编码会覆盖白标启动器的身份 |
| **错误分类** | 抛裸 `Error` | `seamError()` 产出 `code`/`failure`/`status`/`providerRetryAfterMs` | 裸 Error 没有 code，429 既不会被重试也不会显示成限流；401 也不会被识别为鉴权失败 |
| **重试策略** | `return undefined`（用宿主默认） | 显式策略，`maxDelayMs` 提到 60s | 千帆会因突发流量返回 `429 + Retry-After`（几十秒），宿主默认 10s 上限会把服务端建议丢掉 |
| **模型发现** | 无 | `registerModelDiscovery` + 5 分钟缓存 | 静态目录会随模型上下线失真；发现接口让配置界面拿到网关当前真正接受的 id |
| **输出上限** | 一个全局 `32768` | 按模型自己的 ceiling，超限前先夹 | ERNIE-5.5 允许 1M、GLM-5.x 只给 128k，用统一值会削掉大模型的额度 |
| **空响应** | 静默产出空消息 | 分类后抛错 | 空消息会让这一轮无声结束，用户和 agent 循环都拿不到东西 |

### 空响应的两种成因必须分开

实测同一条请求（`max_tokens: 50`）：

```
第1次: finish=stop    content="OK"                reasoning=35 tok
第2次: finish=stop    content="OK！..."            reasoning=37 tok
第3次: finish=length  content=""                  reasoning=50 tok   ← 额度被思考吃光
```

第 3 次是真实的空响应，但成因是**额度不够**，不是模型退化。所以：

- `finish=length` → 报 `CONTEXT_WINDOW_EXCEEDED`，**不重试**（重试只会再烧一次同样的 token），消息里点名「30 token 的额度被思考吃光，请提高 maxTokens 或降低 reasoningEffort」。
- 其他情况 → 报 `EMPTY_RESPONSE`，**可重试**（退化完成，重发安全）。

如果把两者都标成可重试，一次额度不足会变成 5 次无谓重试。

### 发现接口的返回值取自两处

套餐 `/models` 只给 `id`/`object`/`owned_by`，没有尺寸信息，所以发现结果按 id 去静态目录里补 `contextWindow`/`maxTokens`/模态：

- 目录里有的模型 → 拿到完整元数据
- 目录里没有的（如 `unlimited-ocr-2`）→ 只给 id，留给后续补录

实测发现 12 个模型，其中 `unlimited-ocr-2` 是静态目录未收录的，正好体现动态发现的价值。

### 安全边界

发现请求只在**两种**情况下使用已保存的 key：

1. 请求自带 `apiKey`（一次性凭据）
2. `request.provider === 'qianfan'`（问的就是我们自己的路由）

对一个陌生 `baseURL` 做发现时不会发送已存的付费 key——避免把凭据送给第三方端点。

## 已知限制

- DeepSeek 系列不支持 `temperature`、`top_p`、`presence_penalty`、`frequency_penalty`、`logprobs`、`top_logprobs`，设了不报错但不生效
- `thinking_budget`（思维链长度上限，最小 100）在官方支持清单里只有 `ernie-5.1`，不在本套餐模型内
- 推理 token 计入 `max_tokens`，上限设太小会只剩思考、正文为空（32 token 上限实测正文全空）
- 千帆的 Anthropic 兼容通道在 `https://qianfan.baidubce.com/anthropic/tokenplan/personal`，本插件不走它
- 模型清单是静态内置的，不调用 `/models` 自动发现

## 用量看板：套餐额度 + 本机计量（0.3.0）

composer 上方多一条额度行，展开后是两组数字。**这两组数字来源不同，不能互相替代**，所以并排显示、各自标注。

### 第一组：套餐额度（官方口径）

唯一权威来源是百度智能云**控制台**的订阅接口：

```
GET https://console.bce.baidu.com/api/qianfan/charge/tokenPlanPersonal/resource
Cookie: <控制台登录 Cookie>
X-Requested-With: XMLHttpRequest
```

返回 `{success, result: {items: [...]}}`，`billingMode: "credit"` 时读 `usedCredits`/`totalCredits`，`"token"` 时读 `usedTokens`/`totalTokens`；`expiresAt` 是套餐到期时间（控制台写的是不带时区的中国时间，插件按 `+08:00` 解析）。

**为什么必须用 Cookie 而不是 API Key**：这是两个不同的凭据类。推理 key 打这个接口一律 302 到登录页；Baidu 也没有发布任何 key 鉴权的额度接口——`/v2/tokenplan/personal/{usage,quota,plan,balance,credits,…}` 逐一实测全 404，`chat/completions` 只回 token 计数、不含额度信封。所以「用 API Key 查套餐额度」这条路在服务端不存在，不是插件没实现。

Cookie 存在凭据库的 `BAIDU_QIANFAN_COOKIE`，也可以走环境变量或插件配置的 `cookie` 字段。保存前会先探一次：探不通（登录过期）就不写；探得通才存，并把探测结果一并发回页面。

### 为什么必须用 Copy as cURL，而不是复制 Cookie 值

登录票 `BDUSS` 是 **HttpOnly** 的。实测该域 `document.cookie` 返回 34 个 Cookie，**其中没有 `BDUSS`**；把这一整套发给额度接口，仍然 `302` 跳登录页。开发者工具「应用」面板的值单元格同样看不到它，任何页面脚本能读到的请求头也不含它；请求捕获工具按设计把 `cookie` 显示为 `[redacted]`，也取不到。

浏览器里唯一会带上它的动作是**在网络面板里右键请求 →「Copy as cURL」**。所以插件直接接受整段 cURL 命令（也接受 `-b` / `--cookie` 形态），从中抽出 `Cookie` 头。没有 `BDUSS` 的头部一律拒收，并在错误里指明应该改用 Copy as cURL——否则会存进一个「已配置」但永远失败的凭据。

### 自动提取（需要一次权限授予）

`tools/qianfan-cookie-extract.mjs` 是另一条路：Chrome 把 Cookie 加密存在本地，密钥在 macOS 钥匙串的 `Chrome Safe Storage` 项里，本地进程可以解密后直接写进凭据库。

macOS 会把 Chrome 的 Cookie 库挡在**完全磁盘访问权限**后面。给权限前后都实测过：

| 状态 | 结果 |
|---|---|
| 未授权 | `cp`、Finder 代抄、在 Terminal.app 内执行 `cp` 三种方式全部 `Operation not permitted` |
| 授权后 | 一次跑通，`verify=ok`，写入 `refs.BAIDU_QIANFAN_COOKIE` |

授权方式：系统设置 → 隐私与安全性 → 完全磁盘访问权限 → 加上运行这条命令的程序，重启 DSH。之后：

```sh
tools/qianfan-refresh.sh            # 重取并写入
tools/qianfan-refresh.sh --dry-run  # 只验证，不写
```

**已装 launchd 定时任务**（`io.dsh.qianfan-cookie`，每天 04:17 + 登录时各一次）：

```sh
tools/qianfan-cookie-install.sh                             # 安装/更新
launchctl kickstart -k gui/$(id -u)/io.dsh.qianfan-cookie   # 手动触发
tail /tmp/dsh-qianfan-refresh.out.log                       # 看结果
```

两条安全性质，都有测试覆盖：

| 性质 | 为什么重要 |
|---|---|
| 写前必探真实接口 | Chrome 会话过期时只返回 302；若照写会把可用凭据换成坏的，卡片从此只报登录失败 |
| 值未变则不写文件 | 凭据库监听文件变化；每晚无谓重写会让所有消费者重新加载 |

任务从 `~/.dsh/tools/` 运行而不是仓库目录：macOS TCC 不允许后台代理读 `~/Documents`，实测任务读自己的脚本会以 **126** 退出（`Operation not permitted`）；且 launchd 的 PATH 里没有 node（本机只有 DSH 自带的 `~/.local/bin/node`），缺失时是 127。仓库那份是源，`install.sh` 负责同步。

### 为什么提取器不是手写名单

第一版按名字列了 `BDUSS`、`bce-passport-stoken` 等 17 项，`verify` 仍然返回 302。原因是控制台实际认证用的是 `.bce.baidu.com` 域下的 `bce-session`、`bce-long-term-sessionid`，以及精确域名上的 `JSESSIONID`——名单里没有这些。

现在改为完全复刻浏览器的选择规则：按域后缀（含点/不含点两种语义）、路径前缀、`Secure`、过期时间（`expires_utc` 为 0 表示会话 Cookie）筛选，同名时更长的路径优先。发往 `console.bce.baidu.com` 的真实集合是 **39–40 个 Cookie**，不是 17 个。

这条规则有测试覆盖：会拒绝 v20 加密格式、空值、别的域的 Cookie，也会在 `saveRef` 里正确转义引号（Cookie 内含 `"`，不转义会让整份 YAML 解析失败、连带毁掉其他凭据）。

### 第二组：本机计量（这台机器实际计费掉的 token）

适配器每发一次 `usage` 事件，宿主就把它折进套餐自己的三个窗口：

| 窗口 | 长度 | 官方现状 |
|---|---|---|
| 5 小时 | 5h 滚动 | 积分制限制当前限时取消，仍统计 |
| 本周 | 7d 滚动 | 同上 |
| 本月 | 30d 滚动 | 生效 |

计量口径按 Token 制算：`inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens`。千帆 Token 制「不区分输入、输出及缓存 Token」，所以缓存命中部分也要计入——这和 harness 内部互斥三元组的语义不同，两者不能混用。

**它的意义是兜底与对照**：没有 Cookie 时它是唯一能看的数字；有 Cookie 时它告诉你这个订阅里有多少是本机花的。它**不等于**官方已用量，因为控制台统计所有客户端。卡片上写的是「本机计量」，不是「已用」。

### 路由

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/qianfan-usage/usage` | 官方读数（60s 缓存）+ 本机计量 |
| GET | `/qianfan-usage/usage?force=1` | 绕过缓存 |
| GET | `/qianfan-usage/cookie` | 是否已配置（从不回传值） |
| POST | `/qianfan-usage/cookie` | `{ cookie }` → 探测后写入 |
| DELETE | `/qianfan-usage/cookie` | 清除 |

两条路由都过宿主自己的 `connection.requestRejection` / `admit` 门禁，只有本机已登录页面能读。

### 降级行为

| 状态 | 卡片表现 |
|---|---|
| 没有 Cookie | 摘要写「未配置控制台 Cookie」，本机计量照常显示 |
| Cookie 过期 | 摘要写登录过期，本机计量照常显示 |
| 无有效套餐 | `no-plan`，不把过期套餐的 100% 读成「用光了」 |
| 上游超时/网络失败 | 报错文案区分 timeout 与 network，本机计量照常显示 |

设计原则：**官方半边的失败不拖垮本机半边**。额度行不消失、不显示假的 0%。

### 验证

`npm test` 覆盖 57 项：Cookie 形状、时间戳时区、两种计费模式、过期/已释放套餐、重定向归类、窗口算术、路由门禁与写入拒绝、客户端渲染状态、以及 `apply()` 是否真的把两条路由挂上。

未验证的部分：真实付费账号的控制台响应（离线用官方前端字段名构造）、以及浏览器里的实际绘制。
