# 泓动引擎 · AI 电话销售工作台

**Hongdong GEO Voice Agent** · 面向 GEO 业务的本地 AI 语音销售智能体。

本地运行的 Web 项目，已实现 SeedDuplex 语音智能体和 DeepSeek 行业补全、通话意向分析。支持 CRM JSON 导入、逐通提示词快照、文字预演、实时语音试打、分页通话记录、客户原话证据与真实录音回放。FreeSWITCH 自动外呼保留接入契约，尚未拨打真实客户电话。

## 启动

需要 **Node.js 24 或更高版本**，使用其内置 SQLite。首次启动：

```sh
git clone https://github.com/jcy52200/hongdong-geo-voice-agent.git
cd hongdong-geo-voice-agent
npm ci
cp .env.example .env
npm run dev
```

打开 <http://127.0.0.1:5173>。默认 API 端口是 3000，服务仅监听本机地址。不配置密钥也可以使用“规则模拟”。

真实语音：在本地 `.env` 中填写 `SEED_API_KEY`，重启服务，在“客户资料”中添加客户，然后选择 SeedDuplex 并点击连接，允许本地页面使用麦克风。推荐先戴耳机试听。API Key 仅由后端发送到火山引擎，不下发浏览器。这里的“已配置”仅说明环境变量存在，不表示鉴权、额度或模型权限已验证。

行业与通话分析：在现有 `.env` 中补入 `DEEPSEEK_API_KEY` 并重启服务。默认 `DEEPSEEK_MODEL=deepseek-flash`，使用 DeepSeek 4.1 Flash 官方模型别名；无需覆盖现有 SeedDuplex 配置。无 DeepSeek 密钥时任务保留待处理，详情参见 [分析模块说明](docs/analysis.md)。

构建后使用一个本地服务运行：

```sh
npm run build
npm start
```

打开 <http://127.0.0.1:3000>。修改 `.env` 中的 `PORT` 后使用相应端口。数据默认写入 `data/geo.sqlite`，重启后保留，可通过 `GEO_DATABASE_PATH` 指定其他位置。录音默认保存在 `data/recordings/`，可通过 `GEO_RECORDINGS_PATH` 指定；`.env` 和 `data/` 已被 Git 忽略。备份需保留数据库与录音目录。

## 使用顺序

默认首页为 **工作台**（`/#dashboard`），展示实际语音连接、评估、意向与任务数据；支持日期切换及等级跳转筛选。两个业务入口：**模拟电话**（`/#voice`）与 **智能体配置**（`/#prompt`，原“限制词控制”）。模拟电话默认使用 SeedDuplex 真实语音，由您扮演客户，支持静音、结束、计时与逐句记录；不连接 SIP 或拨打客户号码。没有客户时可点击“使用虚构示例客户”。

限制词控制可以直接编辑完整系统提示词、音色、语速和调试补充要求，支持恢复默认草稿、带客户变量预览，以及“保存并去试打”。草稿预览不保存；保存默认用于下一通电话；真实语音试打中可另行发送 session.update，既有初始快照保持不变。开场默认保留原始流程话术，可在模型参数中修改；首句播放锁仍保留。文字规则预演不会调用模型，也不会体现自定义限制词的对话效果。

默认销售脚本已加入首轮拒绝介绍、年包服务内容和 9 类可随时插入的 FAQ，按客户语义回答，之后按进度邀请加微信或确认绑定电话。首轮简单说“不需要/不想了解”时作一次介绍；重复拒绝、要求结束或明确在忙时收尾。年包为 12800 元、全年累计一万多条内容和 3000 多个词汇；季度 3800 元仅在客户询问短期方案时补充。指定话术属于运营方提供的业务口径，未经项目独立核验，不能自行扩展承诺。详见 [销售脚本与快速回复说明](docs/sales-script.md)。

“首轮拒绝快速回复”配置默认开启，使用官方 `replacement.commit` 控制，在首句解锁后的首个最终 ASR 符合条件时发送指定介绍，不额外调用 DeepSeek；状态不适合或已有回复时安全跳过，继续由正常提示词回应。它保留首句播放锁，不承诺真实云端响应时延。已知旧版默认模板会备份并升级；自定义完整提示词保持原样，需在配置页“恢复默认”后保存才采用新脚本。原有音色、开场、补充要求和历史会话快照保留。

1. 在“客户资料”填入虚构示例，或导入自己的 CRM 导出文件。示例文件为 [examples/customers.json](examples/customers.json)，支持 JSON 数组或 `{ "customers": [...] }`。
2. 在“限制词控制”配置称呼、音色、语速、音量、开场及其他模型参数，保存后用于新会话。默认云舟 2.0：`zh_male_m191_uranus_bigtts`。
3. 选一位客户，查看已注入 `&camp`、`&name`、`&phone`、`&address`、`&industry` 的完整提示词。缺失行业由 DeepSeek 根据公司名称补全，含混名称填“未知”；手工行业优先，补全后可导出客户 JSON。
4. 先用文字模拟检查数据流，再用 SeedDuplex 做真实试听。文字模拟是有限规则，无语音模型推理，不代表真实模型效果或完整语义理解。
5. 结束后等待录音保存，在“通话记录”按日期、等级筛选和分页，查看直观对话、A–G 意向评估及客户原话证据，播放原录音或导出 JSON。仅接通的语音试打参与评估，文字模拟排除；本地联调记录不等于已经拨打客户电话。

所有导入记录会先统一校验，再整批写入。电话必须为字符串，保留 `+` 和前导零，去掉空格、括号、连字符后按号码更新客户；当前由服务端生成客户 ID，不接收外部 CRM ID。每次会话保存独立客户、配置、完整提示词与 SHA-256，后续修改客户或角色不会改变既有会话。

## 已实现与当前边界

| 功能 | 当前状态 |
| --- | --- |
| 流程图对话与定制话风 | 完整模板；首轮拒绝介绍、服务内容和 9 类 FAQ；微信许可与号码复核 |
| 首轮拒绝快速回复 | 可配置开关；首句解锁后按最终 ASR 和会话状态使用 `replacement.commit`，不额外调用 LLM |
| SeedDuplex 3.0 | 官方 JSON WebSocket 适配；服务端鉴权；一通一连接 |
| 本地音频 | AudioWorklet 连续重采样；上行16k PCM16、20ms；下行24k PCM16 |
| 首句不可打断 | 先静音模型输入，等服务端音频完成及播放端实际排空确认后解锁 |
| 文本与生命周期 | SQLite 持久化；增量更新同一行、终态覆盖；断线/重启明确结束 |
| 第一次架构重构 | 通用语音核心与浏览器媒体端口分离；独立只读观察；共享类型与历史接通来源迁移 |
| 第一板块 | JSON 导入、CCC 人工单通与 Siphon 电话适配已实现并本地验证；真实注册/首通待验，CRM 提取与批量调度待第三次任务 |
| 第三板块 | DeepSeek 行业补全、持久化分析队列、A–G 带证据意向评估、分页筛选与详情 |
| 通话录音 | 浏览器双向混音；Siphon 双声道线路 WAV 完成后归档，支持详情回放与来源区分 |

浏览器试听会播放声音，电话链路通过独立网关连接同一语音核心，不走本机扬声器。当前使用锁版本并打补丁的 Siphon，已验证双向 UDP/RTP、首句排空与双声道 WAV；阿里平台终端注册和手机首通尚未验收。工程测试入口只允许人工发起一通固定测试号码，见[电话测试操作说明](docs/telephone-pilot.md)。当前没有自动业务挂机工具；可用工作台“结束本次测试”、CLI 的 Ctrl+C、客户信令挂断或10分钟上限收尾。独立观察连接断开只取消观察。文字模拟可在结束分支自动收束。

新版 API 不再提供旧协议中同名的字面事件。本项目把客户转写映射为 `AsrText`、模型文本映射为 `ChatText`，保存最终文本和供应商关联 ID。音频文件单独存储，数据库保存录音元数据；原始音频帧事件仅留生命周期元数据。部分生成文本若被打断，不等于客户实际听完的文本，应结合录音复核。首句锁和手动静音期间不录入麦克风；历史版本无录音，不能补造。结束后请保持页面打开至录音保存完成。

本项目按[用户提供的官方文档](https://docs.volcengine.com/docs/doubao-voice/end-to-end-real-time-voice-full-duplex-version?lang=zh)实现。当前已通过本地 mock 协议测试，**尚未使用真实 API Key 完成云端与麦克风端到端验证**，拟人程度、轻儿化及真实时延需 M1/M2 试听验收。

## 文档与接入

- [总体架构、完整分期与验收标准](docs/plan.md)
- [Siphon 架构适配评估与重构规划（拆除、修改、复用）](docs/architecture-refactor-plan.md)
- [三次重构任务、范围与验收（控制平面最后实施）](docs/refactor-tasks.md)
- [第二次：人工单通测试、ECS 配置与现场验收](docs/telephone-pilot.md)
- [Siphon 锁版本、排空补丁与真实 UDP 回环验证](docs/siphon-poc.md)
- [阿里 CCC API 参数、客户腿证据与凭证边界](docs/aliyun-api-notes.md)
- [完整销售提示词](prompts/sales-agent.md)
- [销售脚本、FAQ、快速回复与配置迁移](docs/sales-script.md)
- [工作台统计口径与 UI 设计](docs/ui-dashboard.md)
- [模型参数及实时控制说明](docs/model-controls.md)
- [SeedDuplex 新版协议与事件映射](docs/seeduplex.md)
- [DeepSeek 行业补全、等级、队列、录音与 API](docs/analysis.md)
- [第一板块接入与已实现分析契约](server/contracts.ts)：`GET /api/integrations/contracts`

主要 API：`GET /api/bootstrap`、`PUT /api/config`、`POST /api/prompt/preview`、`POST /api/customers/import`、`GET /api/customers/export`、`POST /api/customers/enrich`、`GET /api/analysis/status`、`GET /api/sessions`、`POST /api/sessions`、`GET /api/sessions/:id`、`POST /api/sessions/:id/finish`、`POST /api/sessions/:id/analyze`、`GET /api/sessions/:id/recording`、`GET /api/sessions/:id/export`。本地媒体协议为 `/ws/sessions/:id`，一个新建会话只接受一个媒体客户端；中断后新建测试，不重放旧音频。独立只读 `/ws/sessions/:id/observe` 接收会话快照、状态与转写，不接收播放音频；断开仅取消观察，任何入站消息仅关闭该观察连接。

代码分层：`server/prompt.ts` 构建提示词；`seed.ts` 处理供应商传输；`voice/session.ts` 提供通用会话核心与开场锁；`media/port.ts` 定义 PCM 和播放完成契约，`media/browser.ts` 转换浏览器协议，`sessions.ts` 保留兼容入口；`shared/session.ts` 共享会话类型；`store.ts` 保存资料与记录并执行版本化历史迁移；`jobs.ts` 消费既有分析/行业任务；`deepseek.ts` 与 `analysis.ts` 负责模型请求和事实校验；`recordings.ts` 保存录音；`app.ts` 提供 HTTP、媒体及只读观察 WS；`web/` 是 React 工作台。

重构分三次，第一次公共语音核心与浏览器适配已完成；第二次电话网关、双向媒体与线路录音已实现并完成本地验证，云端真实首通待验；第三次才实现控制平面的调度、业务编排、自动工具和时段/频控/停止名单准入。Seed 模型就绪单独记录 `modelReadyAt`，真实电话接通使用 CCC 客户通道证据；浏览器试听的兼容接通时间不代表客户 SIP 接听。详见[三次重构任务与验收](docs/refactor-tasks.md)。

## 验证

```sh
npm run typecheck
npm test
npm run build
```

测试包含 HTTP/WS 全流程、客户导入、提示词快照、转写去重、首句播放门控、双通隔离、DeepSeek mock 请求与证据校验、行业队列、分页筛选和录音存储。自动检查不调用真实 DeepSeek；补入密钥后仍需用人工标注样本核对行业、意向等级与微信号码。真实语音试听、公司 SIP 线路与并发容量需相应环境验收。
