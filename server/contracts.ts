// Versioned interfaces for the local workbench and the future SIP gateway.
export const INTEGRATION_CONTRACTS = {
  version: '2.0',
  crm: {
    status: 'json_import_ready', endpoint: 'POST /api/customers/import',
    body: { customers: [{ camp: '客户公司', name: '联系人', phone: '字符串号码', address: '城市/地址', industry: '可选行业' }] },
    mappings: { '&camp': 'camp', '&name': 'name', '&phone': 'phone', '&address': 'address', '&industry': 'industry' },
    enrichment: '缺失行业写入持久化队列；DeepSeek 按公司名补全，含混名称填未知；手工行业优先。GET /api/customers/export 导出补全后的原资料。',
    note: '已有CRM的提取脚本尚未开发；导出后在本地导入。按规范化电话更新客户。',
  },
  dialer: {
    status: 'reserved', implemented: false,
    futureBoundary: 'FreeSWITCH ESL 调度器 + 每通独立媒体网关；当前无拨号操作端点',
    plannedRequest: { callId: 'UUID', customerId: 'UUID', sipRouteId: 'route-id', campaignId: 'optional' },
    plannedEvents: ['call.ringing', 'call.answered', 'media.playback_completed', 'call.hangup'],
    media: { input: 'PCM16LE mono 16000 Hz, 20 ms / 640 bytes', output: 'PCM16LE mono 24000 Hz' },
    openingLock: '网关必须在真实播放排空后发送 playback_done；收到音频done不等于客户已听完',
    isolation: '一通电话一个模型WebSocket、独立缓冲与prompt快照；电话音频直接走网关，不走扬声器',
  },
  analysis: {
    status: 'implemented', implemented: true, queueTable: 'analysis_jobs',
    model: 'deepseek-flash / DeepSeek V4.1 Flash',
    trigger: '接通且结束（含接通后异常结束）的语音通话写入队列，由后台worker消费；文字模拟排除。',
    input: { sessionId: 'UUID', promptHash: 'sha256', transcripts: [{ kind: 'AsrText | ChatText', text: '...', final: true }] },
    result: {
      grade: 'A 明确意向 | B 可能有意向 | C 无意向 | D 用户在忙 | E 其他 | F 智能助理 | G 骂人',
      wechat: { consent: 'boolean', sameAsDialed: 'boolean', phone: '11位手机号 | null', identifier: '微信号 | null' },
      summary: 'string', evidence: [{ transcriptId: 'UUID', quote: '客户原话' }], needsHumanReview: true,
    },
    endpoints: ['GET /api/analysis/status', 'GET /api/sessions', 'POST /api/sessions/:id/analyze', 'GET /api/sessions/:id/recording'],
    gatewayBoundary: '当前接通表示 SeedDuplex 语音试打初始化成功；接入SIP后必须以真实 call.answered 更新 answeredAt，并提供独立线路录音。',
    note: '结果附客户原话证据；A需许可和已确认微信联系方式，B至少两轮有效回应；不以时长评分。无密钥保留pending，失败最多尝试3次后支持手动重试。',
  },
};
