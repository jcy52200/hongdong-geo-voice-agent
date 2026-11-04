# SeedDuplex 接入约定

核实日期：2026-11-01。依据火山引擎 [Seeduplex 接口](https://docs.volcengine.com/docs/doubao-voice/end-to-end-real-time-voice-full-duplex-version?lang=zh)、[接入必读](https://docs.volcengine.com/docs/doubao-voice/access-must-read?lang=zh)、[音色列表](https://docs.volcengine.com/docs/doubao-voice/tone-list-3?lang=zh)及该接口页提供的[官方 Python 示例](https://portal.volccdn.com/obj/volcfe/cloud-universal-doc/upload_148ee77d3245e465d244b912d1e83c91.zip)。当前没有使用真实 API Key 完成云端端到端测试；音色效果、账户权限及实际回包仍需联调确认。

## 连接与会话

新版 Seeduplex 3.0 使用 `wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue`，握手请求头为 `X-Api-Key`。每个 WebSocket **文本帧**承载一个完整 JSON 事件；音频以 Base64 放入事件字段。不要套用旧版 `/api/v3/realtime/dialogue` 的二进制事件封装。

凭据仅放本机服务端 `.env`，该文件应被 Git 忽略。浏览器只连接本地后端；后端负责云端鉴权，禁止把 API Key 放入前端构建变量、接口响应或日志。

每通电话新建独立连接及会话标识，避免复用客户间的上下文。客户变量渲染到 `session.instructions`，不要当成其他客户的历史对话。创建示例：

```json
{
  "type": "session.create",
  "event_id": "唯一事件UUID",
  "session": {
    "id": "本通电话独立UUID",
    "model": "1.2.6.1",
    "instructions": "已经渲染客户资料的完整提示词",
    "audio": {
      "input": {
        "format": { "type": "pcm", "rate": 16000 }
      },
      "output": {
        "format": { "type": "pcm_s16le", "rate": 24000 },
        "voice": "zh_male_m191_uranus_bigtts",
        "speed": 0,
        "loudness": 0
      }
    }
  },
  "extension": {
    "asr": { "extra": {} },
    "tts": { "extra": {} },
    "dialog": {
      "extra": {
        "enable_loudness_norm": true,
        "enable_music": false
      }
    }
  }
}
```

等待 `session.created` 后才发送业务音频及开场指令；保存返回的 `session.id`。更新使用相同顶层结构的 `session.update`，等待 `session.updated`。示例中的 `extension` 与 `session` 同级。

默认男声为云舟 2.0：`zh_male_m191_uranus_bigtts`。可替换为小天 2.0：`zh_male_taocheng_uranus_bigtts`。河北口音没有独立的官方方言枚举，先由提示词控制轻儿化；不要把近似的北京方言宣称为河北原生音色。

## 音频与事件

上行采用单声道、16 kHz、PCM int16 小端序；建议每 **20 ms** 发送 640 字节原始音频，再做 Base64 编码。必须按实际时间持续发送，不能把整段录音瞬间倾倒到接口。浏览器采集频率不同则先重采样；SIP 接入时也须进行相应转码。下行显式选用 `pcm_s16le`，对应 24 kHz、16 位小端序，避免误把另一种 `pcm` 输出的 32 位数据按 16 位播放。

| 作用 | 事件及字段 |
| --- | --- |
| 创建/更新确认 | `session.created` / `session.updated`，会话标识为 `session.id` |
| 指定开场文本 | 上行 `{ "type": "speech_text_buffer.commit", "event_id": "唯一ID", "text": "完整首句" }` |
| 音频输入 | 上行 `{ "type": "input_audio_buffer.append", "audio": "Base64音频" }` |
| 强制判停 | 上行 `input_audio_buffer.commit`；确认 `input_audio_buffer.committed` |
| 客户开始说话 | `conversation.item.input_audio_transcription.started` |
| 客户文本增量 | `conversation.item.input_audio_transcription.delta`，使用 `item_id`、`delta` |
| 客户文本完成 | `conversation.item.input_audio_transcription.completed`，使用 `item_id`、`transcript`；官方示例兼容回退 `text` |
| 识别失败 | `conversation.item.input_audio_transcription.failed`，记录错误，不能作为有效客户文本 |
| AI 文本增量 | `response.output_text.delta`，使用 `response_id`、`question_id`、`delta` |
| AI 文本完成 | `response.output_text.done`，使用 `response_id`、`text` |
| AI 音频 | `response.output_audio.started` / `.delta` / `.done`；`delta` 为 Base64，起始事件另有 `tts_type` |
| 主动取消播报 | 上行 `response.cancel`；确认 `response.canceled` |
| 暂停/恢复音频上行 | 上行 `input_audio_mute.commit` / `input_audio_unmute.commit` |
| 结束会话 | 上行 `session.close`；确认 `session.closed` |
| 用量及错误 | `response.done` / `error` |

项目中的 `AsrText`、`ChatText` 是内部领域名称，分别对应客户文本和 AI 文本，**不是新版 API 的字面事件名**。增量仅用于临时展示；收到终态时，按 `item_id` 或 `response_id` 用完整文本替换临时稿，避免把终态再追加一次。保存原始事件标识以便排查。开场指定 TTS 的文档没有保证对应的 Chat 文本事件，因此开场文本由本地单独记为 AI 发言。

## 首句媒体锁与插话

提示词与主动开场事件负责内容，首句不可打断由本地媒体层保证。会话建立后进入开场锁：通知云端上行静音、丢弃锁期间的客户音频、不发送取消事件、不清空开场播放队列。核心先确认首句已收到非空有效 PCM，再等待该响应的 `response.output_audio.done` 和对应播放段的实际排空，之后解除锁并发送取消静音事件；无音频的 done、其他响应或错误/过早的排空回执均不能解锁。服务端音频输出结束不等于客户已经听完；未来电话适配器同样需要可验证的播放完成确认。客户挂机、结束或连接错误仍须即时清理会话。

浏览器侧由服务端发送 `{ "type": "audio_done", "opening": true, "playbackId": "本地播放段标识" }`；前端等播放队列排空后回传 `{ "type": "playback_done", "playbackId": "同一标识" }`。这两个是本项目媒体协议，不是 SeedDuplex 云端事件。新前端会回传标识；旧浏览器缺少标识的回执仅在 `BrowserMediaAdapter` 内、收到生成结束后兼容映射到已完成段，保证弱于明确段标识，不能用于未来电话适配器。上游提供 `response_id` 时核心同时核对响应关联；播放段标识和云端响应标识分别管理。

开场后，官方 Python 示例在 ASR started 时清空本地播放队列，并未自动发送 `response.cancel`。若项目额外采用主动取消策略，应只针对仍在播报的旧响应执行，避免误取消紧接着生成的新响应；这属于应用策略，不能描述成官方必需步骤。

本地核心在清空播放时记录旧响应，后续迟到音频不会重新进入播放队列。所有音频状态按通话隔离，不跨客户共享播放缓存。

## 媒体、观察与模型时间

2026-11-03 重构已将语音逻辑移至 `server/voice/session.ts` 的 `VoiceSessionManager`，通过 `server/media/port.ts` 处理规范 PCM 和播放事件。`server/media/browser.ts` 负责浏览器协议；`server/sessions.ts` 保留原 `attach()` 入口。第二次新增 `media/siphon.ts` 与受限人工单通 CLI，电话媒体不经过浏览器；本地验证通过，阿里注册与手机首通待现场验收。

模型返回 `session.created` 后独立记录 `modelReadyAt`。浏览器试听保留原 `answeredAt` 兼容语义，并标记 `answerSource=browser_session`；历史记录只在版本化迁移中按已知浏览器/退役演示来源回填，未来或未知来源不从模型创建事件推断客户接听。这些时间不能作为 SIP 客户腿接通证据。

`/ws/sessions/:id` 只接受浏览器来源的唯一媒体客户端；SIP 媒体使用独立私有入口与逐通一次性授权，浏览器不能接管或改写电话媒体状态。独立 `/ws/sessions/:id/observe` 只推会话快照、状态、转写等元信息，不推 PCM、`audio_done` 或清空指令。观察连接沿用 Host/Origin 访问防护，任何入站消息以 1008 关闭该观察端；正常关闭、异常或积压只取消观察，不结束媒体会话。浏览器媒体断开仍会结束本次试听。

## 关闭及错误处理

结束时先发 `session.close`，等待 `session.closed` 后关闭 WebSocket；应设置有界超时以释放本地资源。直接断链可能产生 `55000001` / `ContextCanceled`。完整处理云端 `error`、WebSocket error/close、启动超时和播放端断开，记录事件标识及握手返回的 `X-Tt-Logid`，日志不得含凭据。

本地 `SeedPeer.close()` 现在返回可等待的关闭结果，重复调用复用同一收尾过程，超时后强制释放连接。应用关闭等待会话/模型清理后再关闭存储，关闭过程幂等并拒绝新的连接；本地通过关闭测试不代表已验证云端各类异常回包。

鉴权或参数错误应停止自动重试并提示修正配置。服务端 5xx 可按有界退避重连，但不得自动重播整通客户录音或重复开场；已建立的电话是否续接由会话状态决定。上行暂停时须发送静音事件，恢复时须发送取消静音事件，否则持续无音频可能超时。并发容量应按账号实际配额联调，不能由本地框架宣称已经验证。

## 浏览器测试修复（2026-11-04）

云端实测 `response.output_audio.started/done` 携带 `response_id`，但 `response.output_audio.delta` 可能仅含 `type/delta/event_id`。核心将无 ID 的首句分片关联到当前受保护的开场播放段；不要求每个音频分片重复携带 ID。首句仍等待匹配 done 和媒体排空，不能以忽略空音频检查来绕过保护。新增回归覆盖实际报文形状、错误 done、首句排空门控及后续无 ID 分片。

工作台的“浏览器语音测试”直接连接 SeedDuplex，使用已保存的限制词与客户变量，不依赖电话网关。另保留“文字预演”作为本地规则流程检查，它不代表真实模型问答效果。

本次验证：150 项自动回归和构建通过；使用本地已有密钥完成真实云端合成与浏览器 WebSocket 链路检查，收到非空 PCM，并在测试端确认后进入 active。该检查未拨打电话，也未替代真人麦克风对话与音质试听。
