# 泓动引擎 · AI 电话销售工作台

**Hongdong GEO Voice Agent** · 面向 GEO 业务的本地 AI 语音销售智能体。

本地运行的 Web 项目，优先实现语音智能体的开发与联调。当前可以导入客户 JSON、生成逐通提示词快照、运行文字流程模拟、连接 SeedDuplex 实时语音、保存与导出 AsrText / ChatText。FreeSWITCH 自动外呼和大模型意向分析保留接入契约，尚未执行真实拨号或生成意向评分。

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

构建后使用一个本地服务运行：

```sh
npm run build
npm start
```

打开 <http://127.0.0.1:3000>。修改 `.env` 中的 `PORT` 后使用相应端口。数据默认写入 `data/geo.sqlite`，重启后保留，可通过 `GEO_DATABASE_PATH` 指定其他位置；`.env` 和 `data/` 已被 Git 忽略。SQLite 文件含客户资料与通话文本，备份时保留整个 `data/` 目录。

## 使用顺序

两个主要入口：**模拟电话**（`/#voice`）与 **限制词控制**（`/#prompt`）。模拟电话默认使用 SeedDuplex 真实语音，由您扮演客户，支持静音、结束、计时与逐句记录；不连接 SIP 或拨打客户号码。没有客户时可点击“使用虚构示例客户”。

限制词控制可以直接编辑完整系统提示词、音色、语速和调试补充要求，支持恢复默认草稿、带客户变量预览，以及“保存并去试打”。草稿预览不保存；保存默认用于下一通电话；真实语音试打中可另行发送 session.update，既有初始快照保持不变。开场默认保留原始流程话术，可在模型参数中修改；首句播放锁仍保留。文字规则预演不会调用模型，也不会体现自定义限制词的对话效果。

1. 在“客户资料”填入虚构示例，或导入自己的 CRM 导出文件。示例文件为 [examples/customers.json](examples/customers.json)，支持 JSON 数组或 `{ "customers": [...] }`。
2. 在“限制词控制”配置称呼、音色、语速、音量、开场及其他模型参数，保存后用于新会话。默认云舟 2.0：`zh_male_m191_uranus_bigtts`。
3. 选一位客户，查看已注入 `&camp`、`&name`、`&phone`、`&address` 的完整提示词；行业可显式提供，避免从模糊公司名猜测。
4. 先用文字模拟检查数据流，再用 SeedDuplex 做真实试听。文字模拟是有限规则，无语音模型推理，不代表真实模型效果或完整语义理解。
5. 结束后在“通话记录”查看文本、提示词快照或导出 JSON。界面中的会话是本地联调记录，不等于已经拨打客户电话。

所有导入记录会先统一校验，再整批写入。电话必须为字符串，保留 `+` 和前导零，去掉空格、括号、连字符后按号码更新客户；当前由服务端生成客户 ID，不接收外部 CRM ID。每次会话保存独立客户、配置、完整提示词与 SHA-256，后续修改客户或角色不会改变既有会话。

## 已实现与当前边界

| 功能 | 当前状态 |
| --- | --- |
| 流程图对话与定制话风 | 完整模板；可配置开场、分支、价格、原理、微信和号码复核 |
| SeedDuplex 3.0 | 官方 JSON WebSocket 适配；服务端鉴权；一通一连接 |
| 本地音频 | AudioWorklet 连续重采样；上行16k PCM16、20ms；下行24k PCM16 |
| 首句不可打断 | 先静音模型输入，等服务端音频完成及播放端实际排空确认后解锁 |
| 文本与生命周期 | SQLite 持久化；增量更新同一行、终态覆盖；断线/重启明确结束 |
| 第一板块 | JSON 导入可用；CRM 提取脚本、云 SIP、FreeSWITCH 和批量拨号待开发 |
| 第三板块 | 完成会话产生 pending 分析任务；没有消费 worker、LLM 结果或意向看板 |

浏览器在语音测试时会播放声音，便于调试；后续自动外呼将由独立 FreeSWITCH 媒体网关直连语音适配器，不走本机扬声器。当前没有电话挂断工具：真实模型说完告别后，需要点击“结束本次测试”；关闭页面、断线、服务停止及10分钟测试上限也会释放资源。文字模拟可在结束分支自动收束。

新版 API 不再提供旧协议中同名的字面事件。本项目把客户转写映射为 `AsrText`、模型文本映射为 `ChatText`，保存最终文本和供应商关联 ID；音频数据不落库，原始音频事件只保留生命周期元数据。部分文本若被客户打断，其生成文本不等于客户实际听完的文本，后续分析应结合打断事件理解。

本项目按[用户提供的官方文档](https://docs.volcengine.com/docs/doubao-voice/end-to-end-real-time-voice-full-duplex-version?lang=zh)实现。当前已通过本地 mock 协议测试，**尚未使用真实 API Key 完成云端与麦克风端到端验证**，拟人程度、轻儿化及真实时延需 M1/M2 试听验收。

## 文档与接入

- [总体架构、完整分期与验收标准](docs/plan.md)
- [完整销售提示词](prompts/sales-agent.md)
- [模型参数及实时控制说明](docs/model-controls.md)
- [SeedDuplex 新版协议与事件映射](docs/seeduplex.md)
- [可读取的第一、三板块接入契约](server/contracts.ts)：`GET /api/integrations/contracts`

主要 API：`GET /api/bootstrap`、`PUT /api/config`、`POST /api/prompt/preview`、`POST /api/customers/import`、`POST /api/sessions`、`GET /api/sessions/:id`、`POST /api/sessions/:id/finish`、`GET /api/sessions/:id/export`。本地媒体协议为 `/ws/sessions/:id`，一个新建会话只接受一个客户端连接；中断后新建测试，不重放旧音频。

代码分层：`server/prompt.ts` 构建提示词；`seed.ts` 处理供应商传输；`sessions.ts` 管理独立会话及开场锁；`store.ts` 保存资料与记录；`app.ts` 提供 HTTP/WS；`web/` 是 React 工作台。扩展拨号时先把会话媒体与浏览器拆成通用端口，再接 FreeSWITCH，避免将浏览器权限、播放确认和电话线路混在一起。

## 验证

```sh
npm run typecheck
npm test
npm run build
```

测试包含 HTTP/WS 全流程、客户导入的原子校验、提示词快照、转写去重、首句实际播放确认门控、双通隔离及双方断线清理。真实语音试听、公司 SIP 线路与并发容量仍需相应环境验收。
