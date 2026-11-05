# 真实电话测试：外接信息与准备检查

核对日期：2026-11-05（北京时间）。这是只读检查结果，不是电话验收报告。本轮没有发出 SIP 注册、修改 ECS、安装服务或拨打电话。敏感值仍存私有配置，本文不记录密码、AccessKey、测试手机号、服务器实际 IP 或客户资料。

**结论：软件已有人工单通测试能力，但当前外接信息和 ECS 运行环境尚不充足。** 当前路线是阿里 CCC 平台号码、专用坐席 SIP 终端、Siphon 信令/媒体网关、现有 SeedDuplex；FreeSWITCH 不在这条链路中，第三阶段业务控制平面仍未实施。

## 1. 本次实际检查

| 检查对象 | 结果 | 能证明什么 / 仍缺什么 |
| --- | --- | --- |
| ECS SSH | 专用本机密钥已能登录 | 上次的公钥授权阻塞已解除，无需再次提供私钥 |
| ECS 系统 | x86_64、Ubuntu 24.04.4、glibc 2.39 | 满足已锁定 SIP 官方二进制的基础系统条件；实际安装仍待执行 |
| ECS 资源 | 2 核；总内存约 1612 MiB、检查时可用约 477 MiB；根盘可用约 21 GiB | 当前空闲内存有限，不能判定运行资源充足；部署时重新测量。不宜直接在此机编译 Rust 镜像；优先准备匹配 amd64 的预构建产物，再测运行内存，必要时扩容 |
| ECS 工具 | 默认 PATH 和已检查的常见 Node 目录未检测到 Node/npm；未检测到 Docker、Siphon；Python3/Git/OpenSSL 存在 | 仍需安装 Node24+、Docker/Compose、锁定 SIP 二进制与带补丁媒体引擎 |
| ECS 服务状态 | 项目预期的 3000、3001、5061、8080、8081、9092 未见监听 | 当前没有可验收的已运行电话链路；不能据此推断所有目录都未部署 |
| ECS → CCC/Seed/DeepSeek | 三个服务的 443/TCP TLS 握手及系统 CA 校验成功 | 基础网络可达；不证明 API 凭据、权限、模型额度或业务接口调用成功 |
| ECS → 官方坐席注册示例 | `sh-sip.ccc.aliyuncs.com:8443` 可连通，但系统 CA 校验失败：`unable to get local issuer certificate`（code 20） | 需要确认实例实际端点及可信 CA/中间证书链；不能以禁用 TLS 校验代替解决，也未验证实际 Siphon 的证书验证结果 |
| 本地 CCC 配置 | 地域、实例、坐席、候选主叫已填；RAM AK/Secret 缺失 | 未能执行实例身份、Caller 权限、坐席模式/状态的实际 API 验证 |
| 本地 SIP 配置 | 分机、密码、认证用户已填 | 认证用户目前仅有配置，仍需确认；domain、registrar、来源 CIDR 缺失 |
| 本地模型配置 | Seed/DeepSeek Key 已填；浏览器 Seed 语音已在上轮真实云端验证 | ECS 上需迁移私有配置并重新验通；本次未重新调用收费模型 API |
| 搜索附加项 | 搜索 Key 未填，当前模型配置未开启联网搜索 | 当前首通不受此项阻塞；若开启搜索才另行补 Key |
| 网关鉴权 | 两个本地独立控制密钥已填 | ECS 的 secret 文件、权限、挂载与内容一致性尚未准备/验证 |
| 历史资源 | 本地库没有 SIP 通话记录，也没有未知电话资源锁 | 这只是本地库状态，不证明云端坐席空闲；ECS 使用独立库时需再检查 |

本地执行 `npm run phone:doctor -- --online` 返回退出码 2，缺项为：

```text
ALIBABA_CLOUD_ACCESS_KEY_ID
ALIBABA_CLOUD_ACCESS_KEY_SECRET
ALIYUN_SIP_DOMAIN
ALIYUN_SIP_REGISTRAR_URI
ALIYUN_SIP_SOURCE_CIDRS
```

此外本地网关没有连接/鉴权/注册成功的在线证据。`phone:doctor` 不检查全部 ECS 部署条件，因此填完这五项不等于所有准备完成。

## 2. 需要从阿里确认的信息

| 信息 | 应提供的内容 | 对应配置 / 验证 |
| --- | --- | --- |
| CCC 身份 | 地域、InstanceId、完整 UserId | 已有值保留；UserId 不是 SIP 分机号 |
| API 凭据 | 能操作该实例/坐席的 RAM AK/Secret；使用临时凭据时加配套 STS Token | `ALIBABA_CLOUD_ACCESS_KEY_ID/SECRET`、可选 `ALIBABA_CLOUD_SECURITY_TOKEN`；密钥只写私有 `.env` |
| API 权限 | 实际能调用 `MakeCall`、`PollUserStatus`、`ListOutboundNumbersOfUser`、`ReleaseCall` | 本阶段仅用这四类动作；不要用 SIP 密码替代 API 凭据 |
| 外呼主叫 | 当前坐席获准使用的完整 Number | `ALIYUN_CCC_CALLER` 与号码列表精确匹配，保留体验号完整值，不截短、不猜测 |
| 测试被叫 | 已确定的固定测试手机是否在实例允许的白名单中，当前剩余额度 | `PILOT_TEST_PHONE` 已填；还需要平台侧确认 |
| SIP 身份 | SIP 话机分机、认证用户名、密码、SIP domain/realm | `ALIYUN_SIP_EXTENSION/AUTH_USER/PASSWORD/DOMAIN`；认证用户名不能仅凭分机推定 |
| 注册服务 | **坐席终端的正式 registrar DNS 域名、远端端口、传输协议**，若有 outbound proxy 也需给出 | `ALIYUN_SIP_REGISTRAR_URI`；当前模板的协议是 TLS over TCP |
| TLS 信任 | 实际服务器证书名称、完整证书链、需额外信任的 CA；是否要求客户端证书 | 先解决示例端点的证书链校验问题，再验证 Siphon 使用的信任源；不默认关闭 `verify_server` |
| 信令来源 | 阿里发出 INVITE 的来源 IP/CIDR、是否会独立新建到 ECS 的 TLS 连接，还是复用注册连接 | `ALIYUN_SIP_SOURCE_CIDRS`、SIP 公告地址、ECS 安全组；DNS 解析结果不能冒充官方完整网段 |
| 媒体要求 | 对端媒体 IP/CIDR、RTP/RTCP 端口范围、Codec、RTP 或 SRTP、若 SRTP 则其密钥协商方式、AVPF/RTCP mux 要求 | 与实际 SDP 和网关支持能力逐项核对；模型侧 16k/24k PCM 不是电话线路 Codec |
| 坐席操作 | 初始化 SIP 话机、选择正确接听设备/工作模式；若该模式需要签入和就绪，先人工完成 | 程序没有自动切换模式或签入的流程；仅检查 API 身份和无活动通话不足以代替这一步 |
| 第三方终端 | 该实例/体验版是否允许 Siphon 作为专用 SIP 终端接入 | 官方以 Linphone 为接入示例，其他终端仍需验证 |

阿里[坐席软电话官方说明](https://help.aliyun.com/zh/ccs/cccai/use-cases/connect-an-sip-softphone)的上海示例是 domain `sh-sip.ccc.aliyuncs.com`、服务器 `sh-sip.ccc.aliyuncs.com:8443`、TLS；它是**需与当前实例确认的候选**，并非本次已经注册成功的配置。

若确认适用，当前 Siphon 配置形式是：

```dotenv
ALIYUN_SIP_DOMAIN=sh-sip.ccc.aliyuncs.com
ALIYUN_SIP_REGISTRAR_URI=sip:sh-sip.ccc.aliyuncs.com:8443
```

这只是格式示例，不已写入私有配置。Siphon 的 `transport: tls` 在 YAML 单独设置，registrar URI **不能追加 `;transport=tls`**；这是锁定版本解析器的限制。当前模板没有可直接改成 UDP/TCP 的环境开关。

### TLS 兼容性是独立的接入前置

本次还只读检查了该示例端点提供的公开证书元数据，没有发送凭据或 REGISTER，也没有更改任何生产校验设置。返回的 SAN 为 `DNS:*.ccc.aliyuncs.com` 和 `DNS:ccc.aliyuncs.com`，不是 `sh-sip.ccc.aliyuncs.com` 的精确名称；这项元数据读取本身不建立证书信任。

锁定的 Siphon v1.15.11 源码使用 SIP 的严格名称验证，不接受通配符匹配。因此，**即使补齐 CA 链，也预期仍存在注册域名匹配问题**；尚未用实际 Siphon 对该端点完成验证，不能声称注册必定成功。需要阿里给出合适的正式终端端点及证书，或在接入任务中明确调整并验证网关 TLS 兼容方式。不能把它简化为“填完环境变量即可注册”。

网关真实支持的 registrar 信任配置是顶层 `tls.server_ca`，示意如下：

```yaml
tls:
  certificate: /absolute/path/ecs-sip-server-chain.pem
  private_key: /absolute/path/ecs-sip-server.key
  verify_server: true
  server_ca: /absolute/path/verified-provider-ca-bundle.pem
```

此配置需在实际私有 YAML 中明确加入，当前项目没有对应的 `.env` 开关。`server_ca` 的 PEM bundle **替换**网关内置 Mozilla 根证书；网关默认不自动采用 Ubuntu 系统 CA 库，单独执行 `update-ca-certificates` 不代表网关已经信任。ECS 入站服务端证书、出站 registrar 的可信 CA、阿里明确要求双向 TLS 时才需要的客户端证书，是三种不同材料。这里的信任包必须从可信渠道取得，不能把刚下载的任意证书直接当作信任根。

依据：锁定版本的 [TLS 配置与精确域名说明](https://github.com/siphon-project/siphon-sip/blob/f1924f396e367196c782e954c7ad9d42234765b9/siphon.yaml)、[TLS 配置字段](https://github.com/siphon-project/siphon-sip/blob/f1924f396e367196c782e954c7ad9d42234765b9/src/config/tls.rs)、[CA 根证书加载](https://github.com/siphon-project/siphon-sip/blob/f1924f396e367196c782e954c7ad9d42234765b9/src/transport/client_tls.rs)。

此前的 `8000/UDP` 来自[另一种 SIP 网关对接指引](https://help.aliyun.com/zh/ccs/cccai/product-overview/sip-connection-guide)，不能直接当成此坐席终端的注册地址。坐席设备与模式操作见[官方说明](https://help.aliyun.com/zh/ccs/cccai/user-guide/sip-device-and-work-mode)。主叫使用权限见 [MakeCall](https://help.aliyun.com/zh/ccs/cccai/api-ccc-2020-07-01-makecall)。若仍使用体验版，核对其 50 通总试用额度与预设 5 个白名单号码，见[新客户须知](https://help.aliyun.com/zh/ccs/cccai/product-overview/usage-notes)。

## 3. ECS 端口、协议和地址

以下是现有部署模板的端口，不能把远端 registrar 和本机 listener 当成同一个设置。

| 流向 / 用途 | 端口与协议 | 对外范围 |
| --- | --- | --- |
| 管理电脑 → ECS | `22/TCP`，SSH | 管理来源；SSH 本次已验通 |
| ECS → 阿里坐席 registrar | **阿里确认的远端端口**，当前模板 TLS/TCP；官方上海示例 `8443` | ECS 出站，配套 DNS 可达与 CA 校验 |
| 阿里 → ECS SIP listener | 当前默认 `5061/TCP`，TLS | 仅当对方需要独立建立入站信令连接时，按实际 Contact/端口和阿里来源放行；复用注册连接的行为需核实 |
| 阿里媒体 ↔ ECS | 当前引擎本地 `30000–30199/UDP` | 按阿里媒体网段和对端实际端口配置安全组/防火墙；RTCP 或加密要求以协商为准 |
| ECS → CCC、Seed、DeepSeek | `443/TCP`，HTTPS/WSS | 出站；基础 TLS 已验通 |
| Node → Siphon 控制 | `127.0.0.1:9092`，WebSocket/TCP | 本机专用，不公开 |
| Siphon → RTP 引擎控制 | `127.0.0.1:8080`，JSON/TCP | 本机专用，不公开 |
| Siphon 管理 | `127.0.0.1:8081`，HTTP | 本机专用，不公开 |
| 媒体引擎 → Node 音频入口 | `127.0.0.1:3001`，WebSocket/TCP | 本机专用，逐通一次性授权，不公开 |
| 工作台 API/页面 | `127.0.0.1:3000`，HTTP/WS | SSH 本地转发访问；5173 仅开发模式使用 |

还需要准备 `ECS_PRIVATE_IP`、`ECS_PUBLIC_IP`、本机 SIP 公告域名 `SIPHON_ADVERTISED_HOST`、与其匹配的证书链/私钥。当前 YAML 为 TLS listener，启动需要 `SIPHON_TLS_CERT_FILE/KEY_FILE`。ECS 私网地址已通过 SSH 查询到，但尚未落入部署配置；实际值不在公开文档中记录。

`SIPHON_SIP_BIND_IP` 默认是回环地址；需要接收独立入站连接时要改为实际网卡地址。EIP 通常不直接绑定在 ECS 网卡上，不能机械地把公网 IP 填为 bind IP。安全组和操作系统防火墙都需核对。

此模板要求 Node 与 SIP 进程在 ECS 宿主机运行，媒体容器使用 Linux host network。若换成默认 Docker bridge，回环地址、媒体地址和挂载不能原样照搬。

## 4. 可由部署方生成或配置的准备项

- 安装 Node24+、Docker/Compose；准备锁定 SIP v1.15.11 和 RTP engine v0.19.0 **附仓库播放补丁**。只装上游原版不满足首句播放确认要求。
- 采用匹配 ECS CPU 的构建产物；本机 Mac arm64 产物不能当作 ECS amd64 二进制。先测目标机内存余量，避免在现有小内存服务器上直接进行大规模 Rust 编译。
- 把已有私有模型/SIP/API配置安全迁移到 ECS，保持 `.env` 权限 600，不用 `.env.example` 覆盖已有密钥。
- 已有两份本地随机网关密钥；生成 ECS 媒体控制 secret 文件，内容与 `SIPHON_RTP_CONTROL_SECRET` 一致，和 `SIPHON_CONTROL_TOKEN` 分开。
- 配置 `SIPHON_ROUTE_FILE` 的绝对路径与实际 YAML 路径；由服务环境注入所需变量，SIP 启动脚本不会自行加载项目 `.env`。
- 原录音宿主机目录 `SIPHON_RECORDING_DIR` 必须与 Node 的 `PILOT_GATEWAY_RECORDINGS_PATH` 指向同一目录；容器内路径为 `/recordings`，不是宿主机路径。业务归档 `GEO_RECORDINGS_PATH` 另行配置并保留写权限和磁盘余量。
- 保存数据库与限制词/声音配置快照。人工单通 CLI 自启后端，拨号前关闭使用同一数据库的旧后端，避免双进程。
- 测试手机保持可接听，安排一个人配合首句插话、后续打断、FAQ、微信同号/异号与挂机验证。

这些部署工作不需要用户另行提供 CRM 批量任务、FreeSWITCH 配置、RocketMQ、业务调度器或新企业号码。

## 5. 准入顺序与通过标准

1. 确认平台主叫可用、测试手机允许外呼、坐席设备/工作模式正确；收齐 SIP 端点、CA 信任、来源网段和媒体要求。
2. 准备 ECS 运行环境、内存、域名/证书、网关密钥文件和录音挂载；部署锁定版本。检查环境变量注入、网络与证书链。
3. 只读配置检查：`npm run phone:doctor`。SIP 环境已正确注入后运行 `python3 deploy/siphon/preflight.py`。二者都不会拨号，也不验证整套部署。
4. 启动网关并完成实际注册后，再运行 `npm run phone:doctor -- --online`；应得到 `seatIdentityMatches=true`、`seatHasCall=false`、`callerAuthorized=true`、`registered=true`，且缺项和错误为空。注册步骤本身会向阿里发送 REGISTER，应与单纯只读检查区分。
5. 检查实际媒体端口可达、SDP 匹配、本地没有未知外呼资源。**全部通过后，才执行会真正拨号的** `npm run phone:pilot -- --dial --sample`，只向私有配置内的固定测试手机呼叫一次。
6. 真实验收以手机实听、客户通道接通证据、逐句记录、可播放双方 WAV、DeepSeek 结果和外部电话资源释放为准。`unknown` 状态先核对资源，不能直接再拨。

当前检查结果停在第 1/2 步，不能声称已具备直接拨号条件。具体部署顺序与流程见[单通操作文档](telephone-pilot.md)，网关验证证据见[补丁与回环说明](siphon-poc.md)。

## 6. 提供给阿里支持的信息采集单

```text
场景：使用阿里平台外呼号码，通过 CCC MakeCall 发起一通固定白名单手机测试。
Siphon 在 ECS 上注册为专用坐席 SIP 终端，双向音频接自有 SeedDuplex。
请确认此实例允许该接入，并补充：
1. SIP domain/realm、registrar DNS 域名、端口、TLS版本、如需则提供 outbound proxy。
2. 认证用户名是否等于现有 SIP 话机分机号，以及应选择的坐席设备/工作模式。
3. 服务端完整证书链与受信任 CA 的官方下载方式；是否需要客户端证书。
4. 信令来源 CIDR；INVITE 是否复用 REGISTER 的 TLS 连接，或独立连接本方 Contact。
5. 媒体来源 CIDR、对端端口范围、Codec、RTP/RTCP或SRTP、AVPF/RTCP mux要求。
6. 当前 Caller 的使用权、测试手机白名单、剩余额度，以及所需API/RAM坐席权限。
```

非敏感的上述参数可用于对接；RAM Secret、SIP 密码、证书私钥只写入私有文件。
