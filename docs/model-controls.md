# SeedDuplex 参数与通话控制

依据 2026-11-01 读取的[当前 SeedDuplex 3.0 官方文档](https://docs.volcengine.com/docs/doubao-voice/end-to-end-real-time-voice-full-duplex-version?lang=zh)，配置入口为 `/#prompt`，包含“模型参数、完整限制词、实时干预、请求预览”。

## 保存、快照与热更新

保存将完整配置写入本地 SQLite；新会话携带配置快照，构建 `session.create`。历史设置缺少新字段时自动补入应用默认值。默认开场保留原流程话术，可修改并使用 `&camp`、`&name`、`&phone`、`&address`；替换仅执行一次，客户字段中的变量符号不会被继续展开。首句仍先播放、不可打断。

试打中点击“将已保存参数应用到当前通话”会发送 `session.update`，等待 `session.updated` 后才显示确认。初始 QA 不在更新中再次注入；开场文案修改不会自动重播。原始配置、提示词及哈希不修改，更新请求和回包另记入本通事件。官方没有逐字段热更新保证，初始化内容及重置参数应通过新会话验证。请求预览不保存、不联网，搜索密钥显示占位符。

## 参数覆盖

| 分组 | 对应参数 | 约定 |
| --- | --- | --- |
| 限制词 | `session.instructions` | 完整编辑器及调试补充要求，逐通追加客户资料 |
| 声音 | `audio.output.voice/speed/loudness` | 音色 ID 可输入；语速、音量均为 -50 至 100，默认 0 |
| 开场 | `speech_text_buffer.commit` | 可编辑，最长2000字符；不是 API 创建参数，而是会话建立后的主动播报事件 |
| 方言与过滤 | `tts.extra.explicit_dialect/max_length_to_filter_parenthesis` | 仅官方8类方言；过滤范围按文档建议限制为0至100 |
| 二遍识别与词表 | `asr.extra.enable_asr_twopass/boosting_table_id/boosting_table_name/regex_correct_table_id/regex_correct_table_name` | 热词与热词表需同时开启二遍识别 |
| 内联热词、替换词 | `asr.extra.context.hotwords/correct_words` | JSON 编辑；按字段校验，错误草稿阻止保存 |
| 位置、初始 QA | `dialog.location/dialog_context` | 经纬度校验；初始 QA 按 user/assistant 成对，应用限制20轮 |
| 审核 | `dialog.extra.strict_audit/audit_response` | 严格或普通，不表示关闭服务端审核 |
| 联网 | `dialog.extra.enable_volc_websearch/volc_websearch_type/volc_websearch_api_key` | Custom 或 Global；搜索 Key 只通过服务端环境变量注入 |
| 响度、退出意图 | `dialog.extra.enable_loudness_norm/enable_user_query_exit` | 项目默认均衡开启；退出信号记录，不自动挂断 |
| 函数定义 | `session.tools` | 标准函数 JSON Schema，应用最多16个；仅展示请求和手动回传，不执行任意代码 |
| 溯源元信息 | `tts.extra.aigc_metadata` | enable、生产者/传播者及编号；当前 PCM 链路不验证文件头水印 |

当前文档没有独立 pitch、temperature、top_p 参数；不透传其他 TTS 产品的同名字段。音调通过音色选择与限制词风格引导。河北没有独立方言枚举。唱歌与本项目无关，保持 `enable_music=false`。模型版本按文档固定1.2.6.1，上下行 PCM 格式固定为本项目已实现的16k/24k，不能仅修改参数切换为 Opus。

官方页把 context、location、aigc_metadata 的概括类型显示为 string，但其嵌套字段/JSON 示例按对象表达。context 使用当前页显式 JSON 示例，location 参考该页提供的[官方 Web Demo](https://portal.volccdn.com/obj/volcfe/cloud-universal-doc/upload_40e78e155a0960f1fa2cdafc098a4254.zip)的对象构建方式，aigc_metadata 使用嵌套对象结构，与官方同系列示例一致。仍需云端验证音色、权限和扩展参数的实际效果；不以本地 mock 通过代替供应商验收。

## 实时控制

`POST /api/sessions/:id/control` 仅接受项目白名单命令，要求当前会话为已解除首句锁的真实语音会话。该接口不发送任意原始事件或凭据。一通会话同一时间只允许一条需要确认的请求。

| action | 上游事件 | 返回语义 |
| --- | --- | --- |
| apply_config | session.update | 等 session.updated |
| greet | speech_text_buffer.commit | 已发送，无独立 ACK；开场变量按本通客户渲染 |
| replace | speech_text_buffer.replacement.commit | 指定完整回复文本，已发送 |
| replacement_append / replacement_commit | 同名 replacement.append / .commit | 流式分片及结束；应用累计上限8000字符 |
| cancel | response.cancel | 等 response.canceled，并清播放队列 |
| commit_input | input_audio_buffer.commit | 等 input_audio_buffer.committed |
| mute | input_audio_mute.commit / input_audio_unmute.commit | 同步本通浏览器采集状态 |
| context | conversation.item.create/update/retrieve/delete | create/retrieve/delete 等对应回包；update 无明确独立确认时仅显示发送 |
| tool_result | conversation.item.create，role=tool | 必须对应待回传 call_id，等待新增上下文确认 |

确认等待最多8秒，超时不自动重试，避免重复播报或重复修改。等待 ACK 的控制请求被拒绝时返回失败并保留当前通话；没有独立 ACK 的命令只能确认发送，后续云端错误会按语音会话错误处理。结束电话会中止待确认操作。HTTP 回包中的 `sent` 与 `confirmed` 分开显示。手动播报文本记为 AI 文本，表示指定内容，不保证客户实际听完；事件轨迹保留操作者来源。原模型若也返回对应文本，应结合事件来源核对。

上下文新增须完整成对 QA；查询空数组取最近上下文，删除某一侧可能同时删除该轮配对内容。本地通话文字不因模型上下文删除而被擦除。函数调用不自动执行，界面展示 name、arguments 和 call_id，由操作者回传结果。未知 call_id 被拒绝。

第一次重构保留这些人工控制，由通用语音核心执行；只读 `/ws/sessions/:id/observe` 不能提交控制或充当播放端。自动工具执行、外呼调度、业务编排与时段/频控/停止名单准入统一留到第三次控制平面，不因媒体端口完成而提前启用。

`GET /api/sessions/:id/runtime` 提供当前控制记录、静音、分片缓存和待回传函数请求。导出通话包含 `local.control.requested/result/failed`。API Key 与搜索密钥不会写入这些事件，供应商回包意外回显时也作脱敏。

联网时在 `.env` 配置 `SEED_WEBSEARCH_API_KEY` 并重启；未配置时允许保存草稿，但会拒绝启动启用联网的真实会话。主语音 API Key 仍使用 `SEED_API_KEY`。
