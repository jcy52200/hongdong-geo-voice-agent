import { z } from 'zod';
import { DEFAULT_SYSTEM_PROMPT, OPENING } from './prompt.js';
import { modelOptionsSchema } from '../shared/model-config.js';
import { INITIAL_INTRODUCTION_TEMPLATE } from './sales-script.js';
// Four CRM variables are mandatory. Numbers as JSON numbers would lose leading zeros.
export const customerSchema = z.object({
  camp: z.string().trim().min(1).max(160),
  name: z.string().trim().max(80).default(''),
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{5,25}$/, '电话需为字符串，包含5至25位号码字符'),
  address: z.string().trim().max(240).default(''),
  industry: z.string().trim().max(100).optional(),
  competitors: z.array(z.object({
    name: z.string().max(100), area: z.string().max(40), industry: z.string().max(100),
    sourceUrl: z.string().max(8192), sourceTitle: z.string().max(240), nameEvidence: z.string().max(500),
    areaEvidence: z.string().max(500), industryEvidence: z.string().max(500),
  })).max(2).optional(),
}).passthrough();
export const configSchema = z.object({
  agentName: z.string().trim().min(1).max(40),
  voice: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_\-]+$/),
  speed: z.number().min(-50).max(100),
  extraInstructions: z.string().max(8000),
  quickReplyEnabled: z.boolean().default(true),
  competitorPressureEnabled: z.boolean().default(true),
  quickReplyText: z.string().trim().min(1).max(8000).default(INITIAL_INTRODUCTION_TEMPLATE),
  systemPrompt: z.string().trim().min(20, '完整限制词至少需要20个字符').max(24000).default(DEFAULT_SYSTEM_PROMPT),
  loudness: z.number().min(-50).max(100).default(0),
  opening: z.string().trim().min(1).max(2000).default(OPENING),
  modelOptions: modelOptionsSchema.default({}),
});
