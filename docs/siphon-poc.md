# 第二阶段：SIPhon 媒体网关与部署验证

## 交付范围和实际验证

采用 SIPhon SIP `v1.15.11`（`f1924f396e367196c782e954c7ad9d42234765b9`）与 siphon-rtp `v0.19.0`（`4aaaa4b51f4f2d024b0e5224560fc7053157dd79`）。媒体引擎额外应用本仓库 `deploy/siphon/engine-playback-drain.patch`；这是本项目维护的扩展，**不是未经修改的官方版本已有的播放完成 API**。

本机 Docker Linux/arm64 已完成：

- 修改后的完整引擎 `cargo build --locked -p siphon-rtp` 编译成功；实际编译工具链 Rust 1.99.1。
- 原有及新增 bridge 回归共 **109 项通过**。新增覆盖不可打断首句、局部尾帧补齐、溢出/编码失败、不把 clear 当完成、等待实际发送及最后一帧时长。
- 使用官方发布的 SIP v1.15.11 二进制及自带 CPython 3.14t，实际启动纯本地 fixture：YAML 解析成功、Python 脚本注册 2 个 handler、TLS/control/media 监听成功、裸 registrar URI 被加入注册管理器。fixture registrar 指向 localhost，无阿里注册或真实外呼。进一步以实际 TLS INVITE 配合官方 `@siphon-project/control` 0.11.0 验证：正确坐席产生包含真实 ruri/vars 的 StasisStart，路由不自动 answer，控制端可以拒绝，错误目标返回 403。示例探针见 `deploy/siphon/verify-sip-ingress.mjs`，只用于单独的 15061/19092 本地合成 fixture，不读取生产 `.env`。
- Python 路由策略 3 项测试通过：专用坐席只交接控制、错误来源或任一错误目标被拒绝、缺失/全网开放策略拒绝加载；另用纯合成环境执行了正向部署预检，未打印凭证。
- 使用编译后的真实引擎，经 JSON/TCP 控制、真实 UDP RTP 收发与 WebSocket PCM 双向传输完成本地合成音频回环；并验证引擎关闭双轨 WAV 后文件可读、两个声道均有音频。
- 新增实际开始/完成证据后的回环结果：16 kHz PCM WebSocket、43 个下行 UDP RTP 包、36 个上行 PCM 帧；约 35 ms 收到首包实际发送后的 `playing`，500 ms 测试音频在约 637 ms 后返回 `played`；录音 26,924 字节、双声道、已关闭。数字受本机调度影响，**不是云上时延承诺**。

上述验证没有注册阿里坐席、没有发起真实电话，也没有使用真实客户数据。Dockerfile/Compose 提供可重现启动方式；完整 release 镜像构建和下述阿里 SIP/TLS 配置尚需目标 ECS 联调。浏览器试听仍使用原有传输方式。

## 为什么增加引擎补丁

官方 `v0.19.0` 虽然在 schema 中定义 `play_start`、`play_stop`、`mark`，二进制播放边界尚未执行；`clear` 仅回 `name: cleared`。仅凭“收到 TTS 最后一帧”“WS send 回调”“等待估算音频时长”或 `cleared` 不能保证首句的网关播放队列已排空。

补丁在样本域记录每段边界，按协商 ptime 消费，成功编码后跟踪最后一个 RTP 包。只有引擎真实 `datapath.send(...).await` 返回完整发送字节数，且最后一帧的 ptime 已经过，才把对应 `played` 发给应用。未选择 ICE 地址、SRTP 加密失败或 UDP 发送失败会使本流的成功回执失效；溢出、编码失败、打断会取消相关边界。

**保证范围是发送端的媒体排空**：样本已经经引擎发送并走过最后帧的音频时长；不代表公网无丢包、远端 jitter buffer 已播放或手机用户已经听完。SIP/RTP 无法提供手机扬声器的逐帧确认。

官方队列是 **8 个 ptime 帧**，默认约 160 ms、溢出丢旧帧。应用必须按 20 ms 节拍下发，不能一次灌入整段 TTS；补丁不把丢弃样本算作正常播放完成。`play_stop` 会为不足一个 ptime 的已关闭尾段补静音，避免最后半帧永久留队。

## 本项目的实际媒体协议

全部控制帧沿用官方 `{type, data}` envelope；二进制为原始 PCM16 LE，不使用 base64。格式以 `start.data.media` 为准，同一连接上下行一致。

```json
{"type":"start","data":{"streamId":"ws-call-id","callId":"call-id","direction":"duplex","media":{"encoding":"L16","sampleRate":16000,"channels":1,"bitDepth":16,"endianness":"little","ptime":20},"metadata":{"playbackDrainProtocol":"hongdong-playout-v1","playbackDrainScope":"successful_udp_egress_plus_ptime"}}}
```

收到此能力声明才允许电话适配器用播放完成回执解锁首句。没有声明的官方原版引擎应拒绝进入测试通话，不得凭版本号假定支持。

```json
{"type":"play_start","data":{"streamId":"ws-call-id","playId":"opening-1","source":"binary","interruptible":false,"markName":"played"}}
```

接着每 20 ms 发送一帧 16 kHz 单声道 PCM16 LE（640 字节），输出流结束发送：

```json
{"type":"play_stop","data":{"streamId":"ws-call-id","playId":"opening-1"}}
```

首个包含本段样本的 RTP 包实际发送成功后，先回开始证据（每段仅一次）：

```json
{"type":"mark","data":{"streamId":"ws-call-id","playId":"opening-1","name":"playing"}}
```

`playing` 仅表示该段实际开始进入电话线路，不能解锁首句或代表整个段已播完。应以此记录“AI 实际说到第几句”，避免把模型仅生成、尚未播放的第二句话错误计为已经说出。

成功完成的回执为：

```json
{"type":"mark","data":{"streamId":"ws-call-id","playId":"opening-1","name":"played"}}
```

首句期间 `interruptible:false`，局部 VAD 或 `clear` 不得清掉首句；挂断仍然可立即结束通话。后续可打断回答可以使用 `interruptible:true`。正常清播放缓冲：

```json
{"type":"clear","data":{"streamId":"ws-call-id","reason":"barge_in"}}
{"type":"mark","data":{"streamId":"ws-call-id","name":"cleared"}}
```

`cleared` 取消等待中的旧边界，永远不能当作首句已播完。每个 streamId/playId 都需对应当前会话；重复/过期 ID 不能解锁。补丁支持至多 64 个已关闭边界排队，同时仅允许一个尚未 `play_stop` 的二进制段；应用仍应保持自己的小队列，首句优先等回执再推进。

错误通过原生 `type:error` 返回。首个真实电话试验应把包括 `fatal:false` 的任何媒体错误作为完整性失败处理，保存原因并结束会话，不要悄悄继续或用超时替代成功。

## 无外呼的重复验证

先在仓库根目录安装 Node 依赖（验证脚本只使用纯 JS 的 `ws` 包），再执行：

```sh
npm ci
docker compose -f deploy/siphon/compose.media.yml build media
docker compose -f deploy/siphon/compose.media.yml up -d media
docker compose -f deploy/siphon/compose.media.yml --profile verify run --rm verify
docker compose -f deploy/siphon/compose.media.yml down
```

此 Compose 不发布任何宿主机端口。测试容器与引擎共享 Linux network namespace，双方只连接 `127.0.0.1`；录音存在 `loopback-recordings` 卷里，是纯合成测试音频。可加 `down -v` 删除此次验证专用卷，勿把此命令用于实际录音卷。

`verify-media-loopback.mjs` 也可以在安装了 Node、ws 的同一 Linux 主机直接执行；默认控制端口 `127.0.0.1:8080`，录音目录 `/recordings`，可用 `SIPHON_VERIFY_CONTROL_PORT`、`SIPHON_VERIFY_RECORDING_DIR` 调整。启用了控制密钥时用进程环境 `SIPHON_RTP_CONTROL_SECRET`，脚本不打印它。

路由测试执行 `python3 -m unittest discover -s deploy/siphon -p 'test_*.py'`；它不连接真实 SIP。

源代码测试：从上面锁定提交应用补丁，运行 `cargo test --locked -p siphon-rtp-media bridge:: --lib`。新引擎升级必须重新应用、审阅并运行这些回归；不能直接换成未带扩展的官方镜像。

## 阿里 CCC 坐席接入方式

本次使用阿里提供的号码，采用 CCC `MakeCall` 呼叫专用坐席及测试客户；SIPhon 作为坐席 SIP 终端注册，不把平台号码当作任意 FreeSWITCH/SIPhon SIP Trunk。

预期顺序：

1. Node 打开一次性的手动测试窗口、连接 SIPhon 官方控制 SDK，并确认专用坐席已注册。
2. CCC `MakeCall` 请求指定坐席和已授权测试客户号码。SIP 入呼进入 `route.py`，通过阿里来源 CIDR 及专用分机双重校验后，只 `handover("hongdong-pilot")`，此处不 answer、不发起客户呼叫。
3. Node 再检查入呼目标分机及本次测试窗口，生成仅供本次连接使用的媒体 URL，通过官方 SDK `answerAnchored({profile:"hongdong_voice", wsUri, mediaFlags:{wsBargeIn:false, wsSampleRate:16000}})` 接起坐席腿。
4. 媒体连接建立也不等于客户接通；必须等待 CCC 提供本次客户腿的真实 `answered` 状态，才启动 SeedDuplex 首句。坐席腿的 SIP 200、模型创建成功或收到首包均不能当客户接通。
5. 挂断关闭两端、等待原始录音 `RecordingFinished`、记录原始 ASR/ChatText 并触发已有 DeepSeek 评估。

`StasisStart.payload` 的官方结构为：

```json
{"invite":{"method":"INVITE","ruri":"sip:seat@domain","headers":[["To","<sip:seat@domain>"]],"body":{"content_type":"application/sdp","text":"v=0..."}},"source_ip":"192.0.2.10","source_port":5061,"transport":"tls","vars":{"pilot_seat":"seat","pilot_source":"aliyun_ccc"}}
```

目标取 `payload.invite.ruri` 的 user，并校验原始 `headers` 中 `To`/`t`；不是猜测一个不存在的 `payload.to_uri`。源码为锁定 SIP 提交的 `src/dispatcher/b2bua/handover.rs::build_stasis_payload`。脚本对实际 `call.ruri.user` 和 `call.to_uri.user` 都进行匹配；如果阿里的实际 To 与 Contact 规则不同，需要先看脱敏 SIP 报文并明确适配，不能直接放宽成任意号码。

CCC 控制事件、SIP dialog 与媒体流的关联及实际 SDP/late-offer 行为仍需阿里线路联调确认；上述控制方式避免主动伪装通用 trunk，**并不自动证明提供商每种入呼 SDP 都兼容**。

## ECS 准备和启动边界

`compose.ecs.example.yml` 仅供 Linux ECS，使用 host network，但 JSON 控制固定 `127.0.0.1:8080`，不对公网发布。要求设置真实内网 IP、EIP、控制密钥文件及录音目录；缺失即拒绝生成配置。RTP 30000–30199/UDP 仅给阿里正式媒体网段开放；不能开放 `8080/8081/9092` 给公网。

官方 SIP v1.15.11 发布二进制要求 glibc ≥2.39，并随包携带 free-threaded CPython 3.14t。目标机使用 Ubuntu 24.04 或在其容器内运行；Debian 12/较旧 Alibaba Linux 不能假定直接兼容该二进制。自行源码编译则以实际构建的 libc/Python 为准。

`siphon.yaml.example` 必须通过 `start-sip.sh` 启动。需要从阿里坐席控制台/工单确认并在服务器环境填入：

| 变量 | 来源/用途 |
|---|---|
| `ALIYUN_SIP_EXTENSION` | 本次专用坐席分机 |
| `ALIYUN_SIP_AUTH_USER`、`ALIYUN_SIP_PASSWORD` | 坐席 SIP 登录值；只写服务器私有环境 |
| `ALIYUN_SIP_DOMAIN`、`ALIYUN_SIP_REGISTRAR_URI` | 本实例/地域的正式 SIP 域及明确 TLS 端口；registrar 填 `sip:域名:端口`，不要追加 `;transport=tls`，传输由单独的 `transport: tls` 指定 |
| `ALIYUN_SIP_SOURCE_CIDRS` | 阿里正式信令来源网段，逗号分隔，禁止 `0.0.0.0/0` |
| `SIPHON_ADVERTISED_HOST` | 服务器 SIP 域名，须与证书及 Contact 可达性一致 |
| `SIPHON_TLS_CERT_FILE`、`SIPHON_TLS_KEY_FILE` | 服务器证书链/私钥绝对路径，TLS 服务端校验默认启用 |
| `SIPHON_SIP_BIND_IP`、`SIPHON_SIP_PORT` | 默认只监听 127.0.0.1:5061；需要公网入站时显式配置内网接口并配合安全组 |
| `SIPHON_CONTROL_TOKEN` | Node ↔ SIP 控制通道随机密钥，至少 32 字符 |
| `SIPHON_RTP_CONTROL_SECRET` | SIP/Node ↔ 媒体引擎随机密钥，至少 32 字符；与引擎密钥文件内容一致 |
| `SIPHON_ROUTE_FILE` | 本仓库 `deploy/siphon/route.py` 的服务器绝对路径 |
| `SIPHON_CONFIG_FILE` | 可选，复制后的私有 YAML 路径 |

曾提及的 `106.15.103.10:8000` 尚未确认，不能替代当前坐席终端的正式 registrar/TLS 配置；BYOC 8000 文档与坐席终端注册不是同一个接口。

录音路径映射应保持 `SIPHON_RECORDING_DIR`（Compose 的宿主机目录）与 Node 的 `PILOT_GATEWAY_RECORDINGS_PATH` 指向同一目录；Node 的 `SIPHON_RECORDINGS_PATH` 则填写引擎容器内 `/recordings`。二者不是同一种路径，不能把容器内路径直接交给宿主机读取。

启动前先执行 `python3 deploy/siphon/preflight.py`，其只验证部署值，不注册或拨号。生产录音目录须与 Node 进程的本地录音读取目录共享，路径按应用的允许目录约束映射，收到 `RecordingFinished` 再附到通话记录；不得把任意远端 path 当公开文件下载入口。

## 官方来源和网关选择

- [siphon-rtp v0.19.0 的 PCM 队列和控制处理](https://github.com/siphon-project/siphon-rtp/blob/4aaaa4b51f4f2d024b0e5224560fc7053157dd79/crates/siphon-rtp-media/src/bridge/audio.rs)：原版没有成功播放标记执行逻辑。
- [官方 voice-AI cookbook](https://github.com/siphon-project/siphon-rtp/blob/4aaaa4b51f4f2d024b0e5224560fc7053157dd79/docs/cookbook/voice-ai.md)：实际 `type/data`、`start.data.media`、8 帧队列和 answer_local 支持范围。
- [官方解码录音文档](https://github.com/siphon-project/siphon-rtp/blob/4aaaa4b51f4f2d024b0e5224560fc7053157dd79/docs/cookbook/recording.md)：WAV、双轨、关闭事件和 takeover 录音。
- [SIPhon SIP v1.15.11 参考配置](https://github.com/siphon-project/siphon-sip/blob/f1924f396e367196c782e954c7ad9d42234765b9/siphon.yaml)：registrant、control、TLS 与媒体 profile 的真实配置字段。
- [FreeSWITCH mod_audio_stream 商业 v1.1.0 发布](https://github.com/amigniter/mod_audio_stream/releases/tag/v1.1.0)：有完整双向、播放控制/drain、`uuid_record`；演示二进制为 Debian 13/Rocky 9、限制 10 路，商业源码不在公开 source 压缩包。社区版与商业版不可混用能力说明。本机没有与之匹配的 FreeSWITCH/模块 ABI，因此本次以能编译并验证真实 UDP 的 SIPhon 补丁为主线；以后切换 FreeSWITCH 仍需验证模块许可证、包兼容及实际完成事件。
