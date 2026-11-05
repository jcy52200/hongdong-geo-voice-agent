# ECS 无域名运行与 UDP 直连测试

更新：2026-11-05。当前路线已按用户确认改为阿里 UDP 8000 网关直连。坐席分机注册、TLS registrar 与 CCC MakeCall 文档仅保留为旧路线；当前入口不使用这些凭据。

## 已部署的基础通道

| 组件 | 实际配置 | 对外范围 |
| --- | --- | --- |
| Node24 | `/opt/hongdong-geo/runtime/node-v24.14.1-linux-x64` | 项目专用，不替换其他系统应用的 Node |
| 项目代码 / 页面 | `/opt/hongdong-geo/current` | 当前发布目录软链接 |
| 工作台 | `hongdong-workbench.service`，`127.0.0.1:3000` | 通过 SSH 隧道访问，无需网站域名或公网 HTTP 端口 |
| SIP | `hongdong-sip.service`，本机私网接口 `5060/UDP` | 公告公网 EIP；无 REGISTER、无本方 TLS listener |
| 媒体引擎 | `hongdong-media.service`，锁定补丁版 amd64 原生进程 | 控制 `127.0.0.1:8080`；媒体预留 `30000–30199/UDP` |
| SIP 控制 / 管理 | `127.0.0.1:9092` / `127.0.0.1:8081` | 仅回环 |
| Node 音频入口 | `127.0.0.1:3001`，仅单通 CLI 运行时监听 | 不经本机扬声器，也不公开到公网 |
| 私有配置 | `/etc/hongdong-geo/voice.env` | 专用用户可读，权限 600；模型密钥已迁移 |
| SIP 配置 | `/etc/hongdong-geo/siphon.yaml` | 使用 `deploy/ecs/siphon-udp.yaml.example` |
| 模型话术/音色 | 初始配置已从本地设置迁移到 ECS 数据库 | 没有迁移旧 CRM 客户、旧通话或录音 |
| 数据与归档 | `/var/lib/hongdong-geo/geo.sqlite`、`recordings/` | 独立权限与持久目录 |
| 网关原录音 | `/var/lib/hongdong-geo/gateway-recordings` | Native RTP 与 Node 共用真实宿主机路径，不用容器的 `/recordings` 路径 |

运行用户为专用 `hongdong`，服务有独立资源上限。目标机内存有限，媒体引擎在本地构建 amd64 产物再传入，ECS 不进行 Rust 编译，也不依赖 Docker daemon。已有其他系统服务未被停用。

没有售后来源网段时，SIP 脚本只给本机来源回复 OPTIONS，拒绝外部新 INVITE；公网 UFW/安全组的供应商放行项仍待阿里回填。**服务运行、端口监听、本机回环通过均不代表已经接通阿里线路。**

## 1. 准备售后资料

使用[双方交接表](aliyun-udp-handoff-template.md)。本地 `data/handoff/阿里云UDP直连交接表.private.md` 已预填当前账号 UID、ECS、公网地址、候选主叫、已有实例和测试手机；它被 Git 忽略，含真实号码，交付给售后前补齐企业主体、联系人、时间。

必须确认 SBC IP/端口、IP 鉴权、主叫授权、SP/From/被叫 URI 格式、信令和媒体 CIDR、Codec/SDP，以及以下两项：

- **late offer**：当前 Siphon 自动媒体锚定发送不带 SDP 的 INVITE，由对端 200 携带 offer、ACK 携带 answer。若对端要求初始 INVITE 带 SDP，应先适配 early offer，不能把确认开关改为 true 绕过。
- **200 应答含义**：应答必须代表客户真正接听。若只是阿里网关先应答，还需要对方提供客户腿事件并调整开场门控，不能把平台接起当作客户接起。

当前直连入口只实现 IP 鉴权；Digest 注册/401/407 不是这条入口已经具备的能力。旧 CCC 号码列表授权仅供售后核对资源，不能直接当作 UDP 网关主叫使用授权。

## 2. 使用 Workbench 管理 ECS

在本机执行用户已有命令：

```sh
workbench connect -i ECS_INSTANCE_ID
```

进入 ECS 后：

```sh
/opt/hongdong-geo/bin/geo status
/opt/hongdong-geo/bin/geo doctor --online
```

`doctor` 不注册、不拨号；检查字段及本机控制服务。UDP/IP 路线不要求 `registered=true`，因为没有注册。完整准备后应显示缺项/错误为空、`seedKeyConfigured=true`、`gatewayControlReachable=true`。这些只表示相应预检通过，不等于手机通话验收。

## 3. 售后回填后配置线路

在 ECS 编辑私有文件 `/etc/hongdong-geo/voice.env`，由售后给出实际值：

```dotenv
ALIYUN_TRUNK_HOST=售后确认的主SBC_IP
ALIYUN_TRUNK_PORT=8000
ALIYUN_TRUNK_TRANSPORT=udp
ALIYUN_TRUNK_AUTH=ip
ALIYUN_TRUNK_CALLER=售后批准的完整主叫
ALIYUN_TRUNK_TO_TEMPLATE=售后确认的sip_URI模板
ALIYUN_TRUNK_FROM_TEMPLATE=售后确认的From_URI模板
ALIYUN_TRUNK_HEADERS_JSON={}
ALIYUN_SIP_SOURCE_CIDRS=售后信令CIDR列表
ALIYUN_RTP_SOURCE_CIDRS=售后媒体CIDR列表
ALIYUN_TRUNK_LATE_OFFER_CONFIRMED=true
ALIYUN_TRUNK_ANSWER_IS_CUSTOMER_CONFIRMED=true
```

这段不是可直接复制生效的配置，中文值必须替换。两个 true 只能在售后确认后填写。密码和模型 Key 不发到聊天或公开表格。

URI 模板支持 `{phone}`（去掉中国国家码的手机）、`{e164}`（+86 格式）、`{caller}`、`{host}`、`{port}`、`{public_ip}`。例如仅当对方批准此格式时才使用 `sip:{phone}@{host}:{port};transport=udp` 和 `sip:{caller}@{public_ip}`。附加头 JSON 使用售后给出的完整静态值，不做模板展开，不允许覆盖 Via/Route/Contact。

将阿里信令/媒体网段分别加入系统防火墙与 ECS 安全组。先预览本机规则，确认后才加 `--apply`：

```sh
python3 /opt/hongdong-geo/current/deploy/ecs/apply-provider-network.py \
  --signaling '售后信令CIDR' --media '售后媒体CIDR'
```

| 方向 | 协议与本方目的端口 | 来源/目的地 |
| --- | --- | --- |
| 入站信令 | UDP 5060 | 仅阿里确认的信令 CIDR |
| 入站媒体 | UDP 30000–30199 | 仅阿里确认的媒体 CIDR |
| 出站初始 INVITE | UDP → 阿里主 SBC:8000 | 以工单实际值为准 |
| 后续 SIP | UDP，遵循 Record-Route/Route/Contact | 不把 BYE/ACK 统一改写为 8000；对端若返回其他端口需允许 |
| 出站媒体 | UDP → 阿里实际媒体端口 | 按 SDP/工单放行 |
| 云模型/API | TCP 443 | 保持 HTTPS/WSS 出站可达 |

脚本只增加本机 UFW 规则，不更改其他规则、不操作云安全组。云安全组须单独配置相同的受限 UDP 入站条件；不要开放 3000/3001/8080/8081/9092 到公网。没有真实网段时不能预先用全网来源代替。

随后重启 SIP 读取新网段并重新做预检：

```sh
systemctl restart hongdong-sip
/opt/hongdong-geo/bin/geo doctor --online
```

## 4. 无域名访问页面

本机另开一个终端，保留 SSH 隧道：

```sh
ssh -N -i ~/.ssh/hongdong_geo_ecs_ed25519 \
  -L 127.0.0.1:13000:127.0.0.1:3000 root@ECS公网IP
```

把 `ECS公网IP` 换为交接表内地址，浏览器打开 `http://127.0.0.1:13000`。这既能查看通话记录，也能继续浏览器语音测试。无需给网页配域名/HTTPS，不需把管理页直接暴露到公网；localhost 属于浏览器允许麦克风的本地环境。

云端只迁移了初始限制词/音色配置，之后与本地工作台使用不同数据库，不会自动同步。真实拨号前在 13000 的 ECS 工作台核对并保存所需限制词、音色和参数。

本次已建立本机 13000 到该 ECS 工作台的隧道。电脑断网/重启后可以按上述命令重开；如果 13000 已有该隧道，不要再重复绑定同端口。

## 5. 发起一通真实电话

在售后参数、IP 白名单、安全组、本机防火墙和预检全部确认后，在 **Workbench 的 ECS 终端**执行：

```sh
/opt/hongdong-geo/bin/geo pilot --dial --sample
```

**此命令会真正拨打私有 `PILOT_TEST_PHONE` 指定的测试手机。** `--sample` 创建/复用联调资料，不会拨给整个 CRM 列表。只打一通，不循环、不重拨。也可用 `--customer UUID` 指定电话与固定测试手机一致的已有客户。

包装命令会先停普通工作台后端，让单通进程独占同一数据库/3000 端口；电话结束后自动恢复工作台服务并继续处理 DeepSeek 队列。按 Ctrl+C 请求挂断并等待资源结果，不要用关闭终端代替正常收尾。手机可听到 AI，网页只观察文字/记录，不承担电话音频播放。

查看来源为“真实电话”的记录：`answerSource=sip_gateway`，区分 SIP 接通、模型就绪、实际播放事实；原 WAV 可播放，DeepSeek 评估随后更新。`cleanupStatus=unknown` 或 `state=unknown` 时先核对阿里和网关，不要直接重拨。

## 6. 已验证与尚待验证

已通过本地应用回归、类型检查、构建及 amd64 媒体引擎回归。ECS 合成 SBC 测试只把 SIP 发往 `127.0.0.1:26060`，验证了 UDP INVITE/200/ACK/BYE、真实 Seed 首句、双向 RTP、首句 drain、WAV 归档与资源释放，**没有拨打手机**。

实际验证记录：人工结束测试收到 479 个 RTP 包；合成对端主动挂机测试收到 507 个 RTP 包。两次均为 `status=completed`、`recording=ready`、`cleanup=confirmed`，具有独立首句播放事实。这些是本机合成结果，不是公网手机通话时延或质量承诺。

SIP 原生 `rtpengine.on_recording_finished` 回调会把录音真正关闭的事件写入私有原子凭据；Node 验证 SIP Call-ID/recordingId/路径后归档。这用于处理 SIP 通话关联已删除时控制通道无法转发完成事件的情况，不以“文件出现/时长估算”冒充录音关闭。

外部尚待：阿里正式 SBC/网段、网关主叫与 SP/号码格式、IP 鉴权、late offer、200 客户接听语义、双向公网媒体和手机实听。实际联调结果回填到[交接表](aliyun-udp-handoff-template.md)。
