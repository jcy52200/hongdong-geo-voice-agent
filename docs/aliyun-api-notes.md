# 阿里云 CCC 单通控制接口核对

核对日期：2026-11-03。范围为人工启动一通技术测试电话，不实现批次调度、自动工具执行或控制平面。

## 凭证与线路边界

- SIP 分机号和密码只用于 SIP 话机注册。CCC OpenAPI 使用 RAM AccessKey 或 STS 临时凭证，二者不能互换。
- `UserId` 是 CCC 坐席 ID，例如 `agent@实例`，不是 SIP 分机号。适配器要求显式配置该字段，避免把 API 默认映射到另一坐席。
- `Caller` 必须是实例中该坐席有权使用的阿里平台外呼号码。号码需绑定其技能组或作为个人外呼号码；不能把 SIP 分机当外显号码。[MakeCall 官方说明](https://help.aliyun.com/zh/ccs/cccai/api-ccc-2020-07-01-makecall)
- SIP 主机、端口、传输方式及线路媒体权限仍以实例实际配置为准。API 请求成功不能证明 SIP 网关已注册，也不能证明平台允许该网关作为无人值守的语音终端。

## 最小 API 适配

`server/telephony/aliyun.ts` 提供：

| 方法 | 官方动作 | 参数与用途 |
| --- | --- | --- |
| `makeCall({ callee, caller?, timeoutSeconds? }, signal?)` | `MakeCall` | 人工请求外呼；被叫为测试手机，默认主叫使用配置的平台号码；振铃超时 30–300 秒，默认 60 秒 |
| `pollUserStatus(signal?)` | `PollUserStatus` | 只读查询该坐席的 `CallContext`、客户与坐席各自通道及坐席状态 |
| `listOutboundNumbersOfUser({ pageNumber?, pageSize? }, signal?)` | `ListOutboundNumbersOfUser` | 只读核对该坐席可用的主叫值，默认第一页、每页 100 条 |
| `releaseCall({ jobId, channelId? }, signal?)` | `ReleaseCall` | 按 CCC `JobId` 挂断；不传通道时作用于该坐席所在通道 |

通话发起、轮询和挂断显式带 `InstanceId`、`UserId`、`DeviceId`；号码列表仅带实例、坐席和分页参数。返回值是经过结构验证的 `Data`；外呼返回的 `JobId` 是 CCC 通话 ID，不是本地会话 ID、SIP Call-ID 或媒体连接 ID。[轮询说明](https://help.aliyun.com/zh/ccs/cccai/developer-reference/api-ccc-2020-07-01-polluserstatus)、[挂断说明](https://help.aliyun.com/zh/ccs/cccai/api-ccc-2020-07-01-releasecall)

### 体验版号码确认

体验版通常分配 `669` 开头的长测试号码，该长串不能仅因长度就被判定为资源 ID。官方文档所述“去掉前 3 位和后 2 位、末 2 位为分机”的规则用于**手机呼入试用实例**，不能据此自行改写 `MakeCall.Caller`。应先查询上述只读号码列表，用返回的 `Data.List[].Number` 与配置精确核对；若有分页则继续查询，未查到不得猜测另一个外显值。[体验版说明](https://help.aliyun.com/zh/ccs/cccai/getting-started/quickly-create-a-cloud-contact-center-voice-business-experience-edition)、[坐席外呼号码 API](https://help.aliyun.com/en/ccs/developer-reference/api-ccc-2020-07-01-listoutboundnumbersofuser)

体验版最多 50 通电话，外呼限创建时配置的 5 个白名单号码，名单创建后不能再修改或增加。先在现有试用控制台确认测试手机已位于名单中、仍有测试额度；不要删除或重建演示实例来尝试重置名单。公开文档没有保证该试用实例允许 Siphon 等第三方 SIP 网关，因此仍需实例实际 SIP 注册结果或阿里支持确认。[新客户须知](https://help.aliyun.com/zh/ccs/cccai/product-overview/usage-notes)

官方 TypeScript SDK 元数据将这三个动作定义为 `POST /`、RPC、业务参数位于 query。适配器保持相同的传参位置，使用 HTTPS、`ACS3-HMAC-SHA256` 和 `2020-07-01` 版本头；不发送自行猜测的 JSON 请求体。签名回归使用阿里官方固定输入与签名向量，另覆盖 RFC3986 转义及 STS token。[官方 SDK 源码](https://github.com/aliyun/alibabacloud-typescript-sdk/blob/master/ccc-20200701/src/client.ts)、[V3 签名机制](https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature)

接口设有超时、取消、1 MiB 响应上限和跳转拒绝。服务端原始错误、`Message`、`Params`、未知错误码和网络异常均不直接展示，以免回显电话号码或凭证。适配器从不自动重试；`outcomeUnknown=true` 表示网络中断、超时或异常响应后无法确认外呼是否已被接受，须先核对坐席/平台通话状态，禁止直接再次调用 `MakeCall`。

## 接通和结束的证据

`normalizeCccCall(data, { instanceId, jobId, callee })` 只接受同时匹配实例、通话和目标号码的客户通道。官方规定客户通道的 `UserId` 为空；坐席 SIP 腿接通、坐席 `TALKING`、模型初始化或早媒体均不能替代客户 `ANSWERED`。

- 客户 `ANSWERED` → `answered=true`，使用其 `Timestamp` 作为 `serverTime` / `changedAt`；实际字段不存在时不生成服务器时间。
- 客户 `RELEASED` / `RETIRED` → `ended=true`；该时间仅能表示状态变化，不能补造接听时间。上层须保留已经观测到的接通证据。
- `RINGING` / `EARLY_MEDIA` → 振铃阶段；`CREATED` / `NONE` → 创建阶段。
- 空上下文、其他 JobId、坐席通道、不同号码或多个无法区分的客户通道 → `unknown`；不能据此认定客户正常挂机。

轮询是当前状态快照，有可能遗漏非常短暂的接通或结束状态。调用方应使用有界的技术超时、保存收到时间并按同一 JobId 关联，不能把丢失快照变成客户意向证据。正式的事件推送采用 RocketMQ，需实例另外开通配置；本阶段不虚构 HTTP 回调、媒体 API 或事件字段。[官方事件推送](https://help.aliyun.com/zh/ccs/cccai/user-guide/send-event-notification)

## 配置

`readAliyunCccConfig(env)` 返回 `{ config?, missing, errors }`，错误中只含字段名。`config` 含密钥，只限服务端使用，不得直接作为浏览器状态响应。

| 环境变量 | 内容 |
| --- | --- |
| `ALIBABA_CLOUD_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_SECRET` | RAM API 凭证；不使用 SIP 密码 |
| `ALIBABA_CLOUD_SECURITY_TOKEN` | STS token，可选；需与临时 AK 配套 |
| `ALIYUN_CCC_INSTANCE_ID` | 云联络中心实例 ID |
| `ALIYUN_CCC_USER_ID` | 完整坐席 ID，含 `@实例` |
| `ALIYUN_CCC_CALLER` | 已授权给该坐席的平台外呼号码 |
| `ALIYUN_CCC_REGION_ID` | 默认 `cn-shanghai`；以实际实例地域为准 |
| `ALIYUN_CCC_ENDPOINT` | 默认 `ccc.<地域>.aliyuncs.com`，仅接受 CCC 阿里云服务域名 |
| `ALIYUN_CCC_DEVICE_ID` | 默认 `hongdong-pilot` |
| `ALIYUN_CCC_TIMEOUT_MS` | API 超时，100–60000 毫秒；默认 10000；与振铃超时独立 |

SIP 凭证仍由网关单独读取 `ALIYUN_SIP_EXTENSION`、`ALIYUN_SIP_AUTH_USER`、`ALIYUN_SIP_PASSWORD`、`ALIYUN_SIP_DOMAIN`、`ALIYUN_SIP_REGISTRAR_URI` 和来源网段 `ALIYUN_SIP_SOURCE_CIDRS`。注册地址使用本次部署实际确认的裸 URI，不能把早期 `HOST` / `PORT` 设想当成当前生效配置。不要把任何真实凭证、测试手机号码、线路录音或客户资料写入公开文档和测试。

## 验证范围

离线回归包含官方签名向量、STS、HTTP 模拟服务、控制参数、取消/超时、不确定结果不重试、错误脱敏及客户腿映射。上述验证不代表真实实例授权、SIP 注册、线路双向媒体或真实手机通话已经通过；真实联调需要补齐实例、坐席、RAM 权限和平台外呼号。
