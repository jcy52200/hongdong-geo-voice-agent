// These are versioned extension points, not working SIP/CRM/LLM connectors.
export const INTEGRATION_CONTRACTS = {
  version: '1.0',
  crm: {
    status: 'json_import_ready', endpoint: 'POST /api/customers/import',
    body: { customers: [{ camp: '客户公司', name: '联系人', phone: '字符串号码', address: '城市/地址', industry: '可选行业' }] },
    mappings: { '&camp': 'camp', '&name': 'name', '&phone': 'phone', '&address': 'address' },
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
    status: 'reserved', implemented: false, queueTable: 'analysis_jobs',
    trigger: '已完成会话写入pending任务；尚无worker消费，也不产生意向度',
    input: { sessionId: 'UUID', promptHash: 'sha256', transcripts: [{ kind: 'AsrText | ChatText', text: '...', final: true }] },
    plannedResult: {
      intent: 'unknown | rejected | curious | interested',
      wechatConsent: 'yes | no | unknown', sameAsDialed: 'yes | no | unknown', wechatPhone: 'string | null',
      summary: 'string', evidence: [{ transcriptId: 'UUID', quote: '客户原话' }], needsHumanReview: true,
    },
    note: '结果必须带证据；不以通话时长判定意向，未完成分析时显示待分析。',
  },
};
