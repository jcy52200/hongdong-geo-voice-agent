import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createApp } from './app.js';
import { SiphonControl } from './telephony/siphon-control.js';
import { TelephoneMediaServer } from './telephony/media-server.js';
import { TrunkPilot } from './telephony/trunk-pilot.js';
import { readTrunkConfig } from './telephony/trunk-config.js';
import { Recordings } from './recordings.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const args = process.argv.slice(2), mode = args[0] ?? 'doctor';
const diagnostic = readTrunkConfig();
try {
  if (mode === 'doctor') {
    const report: Record<string, unknown> = { mode: 'aliyun_udp_trunk', missing: diagnostic.missing, errors: diagnostic.errors,
      seedKeyConfigured: Boolean(process.env.SEED_API_KEY), callPlaced: false, registrationRequired: false };
    if (args.includes('--online')) {
      let gateway: SiphonControl | undefined;
      try { gateway = await SiphonControl.connect({ url: process.env.SIPHON_CONTROL_URL || 'ws://127.0.0.1:9092/control/ws', token: process.env.SIPHON_CONTROL_TOKEN || '' }); report.gatewayControlReachable = true; }
      catch { report.gatewayControlReachable = false; process.exitCode = 3; }
      finally { await gateway?.close(); }
    }
    if (!diagnostic.config || !process.env.SEED_API_KEY) process.exitCode = 2;
    console.log(JSON.stringify(report, null, 2));
  } else if (mode === 'call') {
    if (!args.includes('--dial')) throw new Error('实际拨号需显式传入 --dial；检查请用trunk:doctor');
    const config = diagnostic.config;
    if (!config || !process.env.SEED_API_KEY) throw new Error('直连参数未齐，请先运行trunk:doctor，必须确认IP鉴权和late offer支持');
    const index = args.indexOf('--customer'), customerId = index >= 0 ? args[index + 1] : undefined;
    if (!customerId && !args.includes('--sample')) throw new Error('需要 --sample 或 --customer UUID');
    const port = Number(process.env.PORT || 3000);
    const { createServer } = await import('node:net'); const probe = createServer();
    await new Promise<void>((resolve, reject) => { probe.once('error', () => reject(new Error('后端端口占用，先停止原后端以免同时打开数据库'))); probe.listen(port, '127.0.0.1', () => probe.close(() => resolve())); });
    const gateway = await SiphonControl.connect({ url: config.controlUrl, token: config.controlToken });
    const media = new TelephoneMediaServer(); let runtime: ReturnType<typeof createApp> | undefined, pilot: TrunkPilot | undefined;
    const stop = () => { void pilot?.close().catch(() => {}); };
    try {
      await mkdir(config.recordingRoot, { recursive: true, mode: 0o700 }); await media.listen(config.mediaPort);
      const databasePath = resolve(process.env.GEO_DATABASE_PATH || 'data/geo.sqlite');
      const recordingPath = resolve(process.env.GEO_RECORDINGS_PATH || `${dirname(databasePath)}/recordings`);
      runtime = createApp({ databasePath, recordingsPath: recordingPath, apiKey: process.env.SEED_API_KEY,
        webSearchKey: process.env.SEED_WEBSEARCH_API_KEY, deepseekApiKey: process.env.DEEPSEEK_API_KEY,
        deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL, deepseekModel: process.env.DEEPSEEK_MODEL });
      await new Promise<void>((resolve, reject) => { runtime!.server.once('error', reject); runtime!.server.listen(port, '127.0.0.1', resolve); });
      const national = (phone: string) => phone.replace(/^(?:\+86|0086)/, '').replace(/[\s()-]/g, '');
      let customer = customerId ? runtime.store.customer(customerId) : runtime.store.customers().find(item => national(item.phone) === national(config.testPhone));
      if (!customer && args.includes('--sample') && !customerId) {
        customer = runtime.store.importCustomers([{ camp: '河北联调门窗测试公司', name: '测试联系人', phone: config.testPhone, address: '石家庄', industry: '门窗' }])[0];
      }
      if (!customer) throw new Error('客户不存在');
      pilot = new TrunkPilot(runtime.store, runtime.manager, gateway, media, new Recordings(recordingPath), config);
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      const session = await pilot.start(customer.id);
      console.log(JSON.stringify({ sessionId: session.id, note: 'UDP直连人工单通；Ctrl+C结束，不自动重拨' }));
      const final = await pilot.finished; runtime.worker.wake();
      console.log(JSON.stringify({ sessionId: final.id, status: final.status, recording: final.telephone?.recordingStatus, cleanup: final.telephone?.cleanupStatus, analysis: final.analysisStatus }));
    } finally {
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      const a = await Promise.allSettled([pilot?.close()]);
      const b = await Promise.allSettled([media.close(), gateway.close(), runtime?.close()]);
      if ([...a, ...b].some(item => item.status === 'rejected')) { console.error('资源释放未全部确认，先核对再拨号'); process.exitCode = 1; }
    }
  } else throw new Error('用法：trunk:doctor [--online] 或 trunk:pilot -- --dial --sample');
} catch (error) { console.error(error instanceof Error ? error.message : 'UDP直连工程测试失败'); process.exitCode = 1; }
