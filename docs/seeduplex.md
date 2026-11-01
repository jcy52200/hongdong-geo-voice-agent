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

提示词与主动开场事件负责内容，首句不可打断由本地媒体层保证。会话建立后进入开场锁：通知云端上行静音、丢弃锁期间的客户音频、不发送取消事件、不清空开场播放队列。收到开场 `response.output_audio.done` 且播放端确认队列排空后，解除锁并发送取消静音事件。服务端音频输出结束不等于客户已经听完；未来 FreeSWITCH 接口同样需要播放完成确认。客户挂机、结束或连接错误仍须即时清理会话。

开场后，官方 Python 示例在 ASR started 时清空本地播放队列，并未自动发送 `response.cancel`。若项目额外采用主动取消策略，应只针对仍在播报的旧响应执行，避免误取消紧接着生成的新响应；这属于应用策略，不能描述成官方必需步骤。

## 关闭及错误处理

结束时先发 `session.close`，等待 `session.closed` 后关闭 WebSocket；应设置有界超时以释放本地资源。直接断链可能产生 `55000001` / `ContextCanceled`。完整处理云端 `error`、WebSocket error/close、启动超时和播放端断开，记录事件标识及握手返回的 `X-Tt-Logid`，日志不得含凭据。

鉴权或参数错误应停止自动重试并提示修正配置。服务端 5xx 可按有界退避重连，但不得自动重播整通客户录音或重复开场；已建立的电话是否续接由会话状态决定。上行暂停时须发送静音事件，恢复时须发送取消静音事件，否则持续无音频可能超时。并发容量应按账号实际配额联调，不能由本地框架宣称已经验证。
