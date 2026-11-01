import { z } from 'zod';

const shortText = z.string().max(240);
export const locationSchema = z.object({
  longitude: z.number().min(-180).max(180).optional(), latitude: z.number().min(-90).max(90).optional(),
  city: shortText.optional(), country: shortText.optional(), province: shortText.optional(),
  district: shortText.optional(), town: shortText.optional(), country_code: shortText.optional(), address: shortText.optional(),
}).strict();
const qaSchema = z.object({ role: z.enum(['user', 'assistant']), text: z.string().min(1).max(8000), timestamp: z.number().int().nonnegative().optional() }).strict();
export const toolsSchema = z.array(z.object({
  type: z.literal('function'), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
  description: z.string().max(4000).optional(),
  parameters: z.record(z.string(), z.unknown()).refine(value => value.type === 'object', 'parameters.type 必须为 object'),
}).strict()).max(16).refine(tools => new Set(tools.map(t => t.name)).size === tools.length, '函数名不能重复');
export const modelOptionsSchema = z.object({
  asr: z.object({
    enable_asr_twopass: z.boolean().optional(), boosting_table_id: shortText.optional(), boosting_table_name: shortText.optional(),
    regex_correct_table_id: shortText.optional(), regex_correct_table_name: shortText.optional(),
    context: z.object({
      hotwords: z.array(z.object({ word: z.string().trim().min(1).max(100) }).strict()).max(200).optional(),
      correct_words: z.record(z.string().min(1).max(100), z.string().max(240)).optional(),
    }).strict().optional(),
  }).strict().optional(),
  tts: z.object({
    max_length_to_filter_parenthesis: z.number().int().min(0).max(100).optional(),
    explicit_dialect: z.enum(['', 'dongbei', 'sichuan', 'shaanxi', 'yue', 'beijing', 'henan', 'tianjin', 'shanghai']).optional(),
    aigc_metadata: z.object({
      enable: z.boolean(), content_producer: shortText.optional(), produce_id: shortText.optional(),
      content_propagator: shortText.optional(), propagate_id: shortText.optional(),
    }).strict().optional(),
  }).strict().optional(),
  dialog: z.object({
    location: locationSchema.optional(),
    dialog_context: z.array(qaSchema).max(40).refine(items => items.length % 2 === 0 && items.every((item, i) => item.role === (i % 2 ? 'assistant' : 'user')), '历史上下文须按 user / assistant 成对排列').optional(),
    extra: z.object({
      strict_audit: z.boolean().optional(), audit_response: z.string().max(2000).optional(),
      enable_volc_websearch: z.boolean().optional(), volc_websearch_type: z.enum(['web_custom_api', 'web_global_api']).optional(),
      enable_loudness_norm: z.boolean().optional(), enable_user_query_exit: z.boolean().optional(),
    }).strict().optional(),
  }).strict().optional(),
  tools: toolsSchema.optional(),
}).strict().superRefine((options, ctx) => {
  const asr = options.asr;
  if (!asr?.enable_asr_twopass && (asr?.boosting_table_id || asr?.boosting_table_name || asr?.context?.hotwords?.length)) {
    ctx.addIssue({ code: 'custom', path: ['asr', 'enable_asr_twopass'], message: '使用热词/热词表需同时开启二遍识别' });
  }
  if (options.dialog?.extra?.enable_volc_websearch && !options.dialog.extra.volc_websearch_type) {
    ctx.addIssue({ code: 'custom', path: ['dialog', 'extra', 'volc_websearch_type'], message: '开启联网需选择搜索版本' });
  }
});
export type ModelOptions = z.infer<typeof modelOptionsSchema>;

const content = z.array(z.object({ type: z.literal('input_text'), text: z.string().max(8000) }).strict()).min(1).max(4);
const itemId = z.string().min(1).max(160);
const createItems = z.array(z.object({ id: itemId, type: z.literal('message'), role: z.enum(['user', 'assistant']), content }).strict()).min(2).max(40)
  .refine(items => items.length % 2 === 0 && items.every((item, i) => item.role === (i % 2 ? 'assistant' : 'user')), '新增上下文须按完整 QA 成对提交')
  .refine(items => new Set(items.map(item => item.id)).size === items.length, '上下文 ID 不能重复');
export const contextEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('conversation.item.create'), items: createItems }).strict(),
  z.object({ type: z.literal('conversation.item.update'), items: z.array(z.object({ id: itemId, content }).strict()).min(1).max(40) }).strict(),
  z.object({ type: z.literal('conversation.item.retrieve'), items: z.array(z.object({ id: itemId }).strict()).max(40).optional() }).strict(),
  z.object({ type: z.literal('conversation.item.delete'), items: z.array(z.object({ id: itemId }).strict()).min(1).max(40) }).strict(),
]);
export const controlSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('apply_config') }).strict(),
  z.object({ action: z.literal('greet'), text: z.string().trim().min(1).max(8000) }).strict(),
  z.object({ action: z.literal('replace'), text: z.string().trim().min(1).max(8000) }).strict(),
  z.object({ action: z.literal('replacement_append'), text: z.string().min(1).max(8000) }).strict(),
  z.object({ action: z.literal('replacement_commit'), text: z.string().max(8000).default('') }).strict(),
  z.object({ action: z.literal('cancel') }).strict(),
  z.object({ action: z.literal('commit_input') }).strict(),
  z.object({ action: z.literal('mute'), muted: z.boolean() }).strict(),
  z.object({ action: z.literal('context'), event: contextEventSchema }).strict(),
  z.object({ action: z.literal('tool_result'), callId: itemId, text: z.string().max(16000) }).strict(),
]);
export type ControlRequest = z.infer<typeof controlSchema>;
export interface ControlResult { requestId: string; status: 'sent' | 'confirmed'; message: string; event?: Record<string, unknown> }

export const DOCUMENT_URL = 'https://docs.volcengine.com/docs/doubao-voice/end-to-end-real-time-voice-full-duplex-version?lang=zh';
