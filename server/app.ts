import express from 'express';
import { createServer, type IncomingMessage } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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
export function createApp(options: { databasePath: string; apiKey?: string; seedUrl?: string; staticPath?: string; webSearchKey?: string }) {
  const store = new Store(options.databasePath);
  const manager = new SessionManager(store, options.apiKey ?? '', options.seedUrl, options.webSearchKey);
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
    customers: store.customers(), sessions: store.sessions(),
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
    res.json({ customers: store.importCustomers(customers), imported: customers.length });
  });
  app.post('/api/sessions', (req, res) => {
    const { customerId, mode } = z.object({ customerId: z.string(), mode: z.enum(['simulation', 'seed']) }).parse(req.body);
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
    if (error instanceof ControlError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；') }); return;
    }
    if (error?.type === 'entity.too.large') { res.status(413).json({ error: 'JSON 文件超过2MB，请分批导入' }); return; }
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
  return { app, server, store, manager, close: async () => {
    manager.shutdown();
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    store.close();
  } };
}
