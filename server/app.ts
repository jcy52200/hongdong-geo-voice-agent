import express from 'express';
import { createServer, type IncomingMessage } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { DEFAULT_CONFIG, Store } from './store.js';
import { ControlError, SessionManager } from './sessions.js';
import { buildPrompt, DEFAULT_SYSTEM_PROMPT, getOpening, OPENING } from './prompt.js';
import { controlSchema } from '../shared/model-config.js';
import { configSchema, customerSchema } from './validation.js';
import { INTEGRATION_CONTRACTS } from './contracts.js';
import { createSeedSession, SEED_MODEL } from './seed.js';
import { DeepSeekClient } from './deepseek.js';
import { AnalysisWorker } from './jobs.js';
import { Recordings, RecordingError } from './recordings.js';
import { readDashboard } from './dashboard.js';

function localRequest(req: IncomingMessage) {
  const isLoopback = (name: string) => ['localhost', '127.0.0.1', '[::1]'].includes(name);
  try {
    const target = new URL(`http://${req.headers.host}`);
    if (!isLoopback(target.hostname)) return false;
    const origin = req.headers.origin;
    if (!origin) return true; // Local CLI/gateway use; no ambient browser credentials.
    const source = new URL(origin);
    return source.protocol === 'http:' && isLoopback(source.hostname)
      && (source.port === target.port || source.port === '5173');
  } catch { return false; }
}
export function createApp(options: { databasePath: string; apiKey?: string; seedUrl?: string; staticPath?: string; webSearchKey?: string;
  deepseekApiKey?: string; deepseekBaseUrl?: string; deepseekModel?: string; recordingsPath?: string }) {
  const store = new Store(options.databasePath);
  const manager = new SessionManager(store, options.apiKey ?? '', options.seedUrl, options.webSearchKey);
  const worker = new AnalysisWorker(store, options.deepseekApiKey ? new DeepSeekClient({ apiKey: options.deepseekApiKey, baseUrl: options.deepseekBaseUrl, model: options.deepseekModel }) : undefined);
  const recordings = new Recordings(options.recordingsPath ?? resolve(options.databasePath === ':memory:' ? 'data' : dirname(options.databasePath), 'recordings'));
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (!localRequest(req)) { res.status(403).json({ error: '本地工作台仅接受本机来源' }); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/bootstrap', (_req, res) => res.json({
    config: store.config(), provider: { configured: Boolean(options.apiKey), webSearchConfigured: Boolean(options.webSearchKey), model: SEED_MODEL, protocol: 'SeedDuplex 3.0 / JSON WebSocket' },
    customers: store.customers(), sessions: store.sessions(), sessionTotal: store.sessionCount(), analysis: worker.status(),
  }));
  app.put('/api/config', (req, res) => res.json(store.saveConfig(configSchema.parse(req.body))));
  app.get('/api/prompt/default', (_req, res) => res.json({ systemPrompt: DEFAULT_SYSTEM_PROMPT, opening: OPENING, config: DEFAULT_CONFIG }));
  app.post('/api/prompt/preview', (req, res) => {
    const customer = customerSchema.parse(req.body?.customer);
    const config = req.body?.config === undefined ? store.config() : configSchema.parse(req.body.config);
    const id = z.string().max(80).optional().parse(req.body.customer.id) ?? 'preview';
    res.json({ prompt: buildPrompt({ ...customer, id }, config), opening: getOpening(config, { ...customer, id }) });
  });
  app.post('/api/config/preview', (req, res) => {
    const config = configSchema.parse(req.body?.config);
    const customer = { ...customerSchema.parse(req.body?.customer), id: 'preview' };
    res.json(createSeedSession({ id: '00000000-0000-4000-8000-000000000000', prompt: buildPrompt(customer, config), configSnapshot: config }, '[服务端环境变量 SEED_WEBSEARCH_API_KEY]'));
  });
  app.post('/api/customers/import', (req, res) => {
    const { customers } = z.object({ customers: z.array(customerSchema).min(1).max(5000) }).parse(req.body);
    const saved = store.importCustomers(customers);
    worker.wake();
    res.json({ customers: saved, imported: customers.length, analysis: worker.status() });
  });
  app.get('/api/customers/export', (_req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="customers.json"');
    res.json({ customers: store.customers().map(({ industryStatus, industryError, ...customer }) => customer) });
  });
  app.post('/api/customers/enrich', (req, res) => {
    const { retryFailed } = z.object({ retryFailed: z.boolean().default(true) }).parse(req.body ?? {});
    for (const customer of store.customers()) if (!customer.industry?.trim() || (retryFailed && customer.industryStatus === 'failed')) store.enqueueIndustry(customer, true);
    worker.wake();
    res.status(202).json(worker.status());
  });
  app.get('/api/analysis/status', (_req, res) => res.json(worker.status()));
  app.get('/api/dashboard', (req, res) => {
    const range = z.object({
      from: z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString()),
      to: z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString()),
      offsetMinutes: z.coerce.number().int().min(-840).max(840).default(480),
    }).parse(req.query);
    const duration = Date.parse(range.to) - Date.parse(range.from);
    if (duration <= 0 || duration > 93 * 86400000) { res.status(400).json({ error: '请选择不超过93天的有效统计范围' }); return; }
    res.json({ ...readDashboard(store, range), jobs: store.jobCounts(), provider: { seedConfigured: Boolean(options.apiKey), analysisConfigured: worker.status().configured, model: worker.status().model } });
  });
  app.get('/api/sessions', (req, res) => {
    const query = z.object({
      page: z.coerce.number().int().min(1).max(1000000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20),
      answeredOnly: z.enum(['true', 'false']).default('true').transform(value => value === 'true'),
      dateField: z.enum(['createdAt', 'answeredAt', 'endedAt']).default('createdAt'),
      from: z.iso.datetime({ offset: true }).optional().transform(value => value ? new Date(value).toISOString() : undefined),
      to: z.iso.datetime({ offset: true }).optional().transform(value => value ? new Date(value).toISOString() : undefined),
      sortBy: z.enum(['createdAt', 'status', 'grade']).default('createdAt'), sortDir: z.enum(['asc', 'desc']).default('desc'),
      grade: z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G']).optional(), search: z.string().trim().max(160).optional(),
    }).parse(req.query);
    if (query.from && query.to && query.from >= query.to) { res.status(400).json({ error: '结束日期需晚于开始日期' }); return; }
    res.json(store.listSessions(query));
  });
  app.post('/api/sessions', (req, res) => {
    const { customerId, mode } = z.object({
      customerId: z.string(), mode: z.enum(['simulation', 'seed']),
      transport: z.literal('browser', { error: '当前仅支持浏览器试听，演示桥接已停用' }).optional(),
    }).parse(req.body);
    const customer = store.customer(customerId);
    if (!customer) { res.status(404).json({ error: '客户不存在，请先导入客户资料' }); return; }
    if (mode === 'seed' && !options.apiKey) {
      res.status(409).json({ error: '请先在 .env 配置 SEED_API_KEY 并重启服务，或使用文字流程模拟' }); return;
    }
    if (mode === 'seed' && store.config().modelOptions?.dialog?.extra?.enable_volc_websearch && !options.webSearchKey) {
      res.status(409).json({ error: '已开启联网搜索，请先在 .env 配置 SEED_WEBSEARCH_API_KEY 并重启，或关闭联网' }); return;
    }
    res.status(201).json(store.createSession(customer, mode));
  });
  app.get('/api/sessions/:id', (req, res) => {
    const session = store.session(req.params.id);
    if (!session) { res.status(404).json({ error: '通话记录不存在' }); return; }
    res.json(session);
  });
  app.post('/api/sessions/:id/analyze', (req, res) => {
    const session = store.session(req.params.id);
    if (!session) { res.status(404).json({ error: '通话记录不存在' }); return; }
    if (!store.enqueueAnalysis(session.id, true)) { res.status(409).json({ error: '仅已接通且已结束的语音通话参与评估；文字预演不计入意向统计' }); return; }
    worker.wake();
    res.status(202).json(store.session(session.id));
  });
  app.post('/api/sessions/:id/recording', express.raw({ type: ['audio/webm', 'audio/mp4', 'audio/ogg'], limit: '25mb' }), async (req, res) => {
    const session = store.session(req.params.id);
    if (!session) { res.status(404).json({ error: '通话记录不存在' }); return; }
    if (session.mode !== 'seed' || !session.answeredAt || !['completed', 'failed'].includes(session.status)) {
      res.status(409).json({ error: '仅已结束的接通语音通话可以保存录音' }); return;
    }
    if (session.recording) { res.json(session.recording); return; }
    if (!Buffer.isBuffer(req.body)) { res.status(415).json({ error: '录音格式需为 audio/webm、audio/mp4 或 audio/ogg' }); return; }
    const recording = await recordings.save(session.id, req.body, req.get('content-type') ?? '');
    store.saveRecording(session.id, recording);
    res.status(201).json(recording);
  });
  app.get('/api/sessions/:id/recording', (req, res) => {
    const recording = store.session(req.params.id)?.recording;
    if (!recording) { res.status(404).json({ error: '此通话没有可用录音' }); return; }
    const path = recordings.path(req.params.id, recording.mimeType);
    if (!existsSync(path)) { res.status(404).json({ error: '录音文件已被移动或删除' }); return; }
    res.type(recording.mimeType).sendFile(path);
  });
  app.get('/api/sessions/:id/runtime', (req, res) => {
    if (!store.session(req.params.id)) { res.status(404).json({ error: '通话记录不存在' }); return; }
    res.json(manager.runtime(req.params.id));
  });
  app.post('/api/sessions/:id/control', async (req, res) => {
    const command = controlSchema.parse(req.body);
    res.json(await manager.control(req.params.id, command));
  });
  app.post('/api/sessions/:id/finish', (req, res) => {
    if (!store.session(req.params.id)) { res.status(404).json({ error: '通话记录不存在' }); return; }
    manager.finish(req.params.id);
    res.json(store.session(req.params.id));
  });
  app.get('/api/sessions/:id/export', (req, res) => {
    const session = store.session(req.params.id);
    if (!session) { res.status(404).json({ error: '通话记录不存在' }); return; }
    res.setHeader('Content-Disposition', `attachment; filename="session-${session.id}.json"`);
    res.json(store.exportSession(session.id));
  });
  app.get('/api/integrations/contracts', (_req, res) => res.json(INTEGRATION_CONTRACTS));
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
  const staticPath = options.staticPath ?? resolve(fileURLToPath(new URL('../dist/web', import.meta.url)));
  if (existsSync(staticPath)) {
    app.use(express.static(staticPath));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve(staticPath, 'index.html')));
  } else {
    app.get('/', (_req, res) => res.type('text/plain').send('泓动引擎 API 已启动。开发界面：http://127.0.0.1:5173；生产运行先 npm run build。'));
  }
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ControlError || error instanceof RecordingError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；') }); return;
    }
    if (error?.type === 'entity.too.large') { res.status(413).json({ error: '上传内容过大，JSON 上限2MB，录音上限25MB' }); return; }
    if (error instanceof SyntaxError) { res.status(400).json({ error: 'JSON 格式有误，请检查引号与逗号' }); return; }
    // Avoid returning raw SDK/request errors, secrets, or local file paths.
    res.status(500).json({ error: '本地服务处理失败，请检查数据文件权限或重启后重试' });
  });
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const match = path.match(/^\/ws\/sessions\/([a-f0-9-]{36})$/);
    if (!localRequest(req) || !match) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, ws => manager.attach(match[1], ws));
  });
  return { app, server, store, manager, worker, close: async () => {
    manager.shutdown();
    await worker.close();
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    if (server.listening) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    store.close();
  } };
}
