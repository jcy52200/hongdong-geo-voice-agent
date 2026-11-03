import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from './app.js';
import { AliyunCccClient } from './telephony/aliyun.js';
import { readAliyunCccConfig } from './telephony/aliyun-config.js';
import { readPilotConfig } from './telephony/pilot-config.js';
import { SiphonControl } from './telephony/siphon-control.js';
import { TelephoneMediaServer } from './telephony/media-server.js';
import { TelephonePilot } from './telephony/pilot.js';
import { Recordings } from './recordings.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const args = process.argv.slice(2);
const mode = args[0] ?? 'doctor';
const configuration = readPilotConfig();
const keyConfigured = Boolean(process.env.SEED_API_KEY?.trim());
const cccConfig = readAliyunCccConfig();

function isRegistered(value: Record<string, unknown>, extension: string) {
  const entries = Array.isArray(value.registrations) ? value.registrations : [];
  return entries.some(entry => {
    const data = entry as { state?: string; aor?: string };
    return data.state === 'registered' && data.aor?.match(/^sips?:([^@;>]+)@/)?.[1] === extension;
  });
}
async function doctor() {
  let onlineFailed = false;
  const report: Record<string, unknown> = { mode: 'configuration_only', seedKeyConfigured: keyConfigured,
    missing: configuration.missing, errors: configuration.errors, callPlaced: false };
  if (args.includes('--online')) {
    report.mode = 'read_only_online';
    if (cccConfig.config) {
      const api = new AliyunCccClient(cccConfig.config);
      try {
        const [seat, numbers] = await Promise.all([api.pollUserStatus(), api.listOutboundNumbersOfUser()]);
        const checks = { seatIdentityMatches: seat.UserContext?.InstanceId === cccConfig.config.instanceId && seat.UserContext?.UserId === cccConfig.config.userId,
          seatHasCall: Boolean(seat.CallContext?.JobId || seat.UserContext?.JobId), callerAuthorized: numbers.List?.some(item => item.Number === cccConfig.config!.caller) === true };
        report.ccc = checks; onlineFailed ||= !checks.seatIdentityMatches || checks.seatHasCall || !checks.callerAuthorized;
      } catch { report.ccc = { error: 'CCC只读预检失败，请检查RAM权限、实例和坐席配置' }; onlineFailed = true; }
    }
    if (process.env.SIPHON_CONTROL_TOKEN) {
      let control: SiphonControl | undefined;
      try {
        control = await SiphonControl.connect({ url: process.env.SIPHON_CONTROL_URL || 'ws://127.0.0.1:9092/control/ws', token: process.env.SIPHON_CONTROL_TOKEN });
        const registered = isRegistered(await control.registrations(), process.env.ALIYUN_SIP_EXTENSION || '');
        report.gateway = { registered }; onlineFailed ||= !registered;
      } catch { report.gateway = { error: '电话网关未连接、未鉴权或注册状态不可读' }; onlineFailed = true; }
      finally { await control?.close(); }
    }
  }
  console.log(JSON.stringify(report, null, 2));
  if (configuration.missing.length || configuration.errors.length || !keyConfigured) process.exitCode = 2;
  else if (onlineFailed) process.exitCode = 3;
}

async function dial() {
  if (!args.includes('--dial')) throw new Error('这是人工工程测试命令；确认测试准备后添加 --dial，预检命令不会拨号');
  const config = configuration.config;
  if (!config || !keyConfigured) throw new Error('电话配置未完成；先运行 npm run phone:doctor 查看缺失字段名称');
  const customerIndex = args.indexOf('--customer');
  const customerId = customerIndex >= 0 ? args[customerIndex + 1] : undefined;
  if ((!customerId || !/^[a-f0-9-]{36}$/.test(customerId)) && !args.includes('--sample')) throw new Error('需要 --customer 客户UUID，或 --sample 使用固定测试手机的虚构资料');
  const port = Number(process.env.PORT || '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效');
  // Never open the live SQLite database in a second backend process.
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', () => reject(new Error('API端口已占用；请先停止原后端，单通命令会启动同一个工作台')));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
  });
  const control = await SiphonControl.connect({ url: config.controlUrl, token: config.controlToken });
  const media = new TelephoneMediaServer();
  let runtime: ReturnType<typeof createApp> | undefined;
  let pilot: TelephonePilot | undefined;
  let interrupted = false;
  // Closing also cancels the preflight window before any active call exists.
  const stop = () => { interrupted = true; void pilot?.close().catch(() => {}); };
  try {
    if (!isRegistered(await control.registrations(), config.extension)) throw new Error('专用SIP坐席未在网关确认注册；未拨出');
    await mkdir(config.recordingRoot, { recursive: true, mode: 0o700 });
    await media.listen(config.mediaPort, config.mediaBaseUrl);
    const databasePath = resolve(process.env.GEO_DATABASE_PATH || 'data/geo.sqlite');
    runtime = createApp({ databasePath, apiKey: process.env.SEED_API_KEY?.trim(), webSearchKey: process.env.SEED_WEBSEARCH_API_KEY?.trim(),
      deepseekApiKey: process.env.DEEPSEEK_API_KEY?.trim(), deepseekModel: process.env.DEEPSEEK_MODEL?.trim(), deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL?.trim(),
      recordingsPath: process.env.GEO_RECORDINGS_PATH ? resolve(process.env.GEO_RECORDINGS_PATH) : undefined });
    await new Promise<void>((resolve, reject) => { runtime!.server.once('error', reject); runtime!.server.listen(port, '127.0.0.1', resolve); });
    const phoneKey = (value: string) => value.replace(/^(?:\+86|0086)/, '').replace(/[\s()-]/g, '');
    let customer = customerId ? runtime.store.customer(customerId) : runtime.store.customers().find(item => phoneKey(item.phone) === phoneKey(config.testPhone));
    if (!customer && args.includes('--sample')) {
      runtime.store.importCustomers([{ camp: '河北联调门窗测试公司', name: '测试联系人', phone: config.testPhone, address: '石家庄', industry: '门窗' }]);
      customer = runtime.store.customers().find(item => phoneKey(item.phone) === phoneKey(config.testPhone));
    }
    if (!customer) throw new Error('客户记录不存在');
    const recordingsPath = process.env.GEO_RECORDINGS_PATH ? resolve(process.env.GEO_RECORDINGS_PATH) : resolve(databasePath, '..', 'recordings');
    pilot = new TelephonePilot(runtime.store, runtime.manager, new AliyunCccClient(config.ccc), control, media, new Recordings(recordingsPath), config);
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const session = await pilot.start(customer.id);
    console.log(JSON.stringify({ sessionId: session.id, status: session.status, workbench: `http://127.0.0.1:${port}`, note: '仅本通人工测试；Ctrl+C结束，不自动重拨' }));
    const result = await pilot.finished;
    // Bounded wait for the persistent worker; pending/retry work survives exit.
    runtime.worker.wake();
    const analysisDeadline = Date.now() + 55000;
    while (!interrupted && runtime.worker.status().configured && Date.now() < analysisDeadline) {
      const status = runtime.store.session(result.id)?.analysisStatus;
      if (status !== 'pending' && status !== 'running') break;
      await delay(250);
    }
    const final = runtime.store.session(result.id)!;
    console.log(JSON.stringify({ sessionId: final.id, status: final.status, telephoneState: final.telephone?.state,
      recording: final.telephone?.recordingStatus, analysis: final.analysisStatus, cleanup: final.telephone?.cleanupStatus }));
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    // Keep control/media alive while the pilot attempts every remote cleanup.
    const pilotClosed = await Promise.allSettled([pilot?.close()]);
    const servicesClosed = await Promise.allSettled([media.close(), control.close(), runtime?.close()]);
    if ([...pilotClosed, ...servicesClosed].some(item => item.status === 'rejected')) {
      console.error('部分资源关闭未确认，请核对CCC与网关后再启动下一通'); process.exitCode = 1;
    }
  }
}

try {
  if (mode === 'doctor') await doctor();
  else if (mode === 'call') await dial();
  else throw new Error('用法：phone:doctor [--online] 或 phone:pilot -- --dial --customer UUID / --sample');
} catch (error) {
  // All external adapters already sanitize errors; never dump configuration or SDK stacks.
  console.error(error instanceof Error ? error.message : '电话工程测试失败'); process.exitCode = 1;
}
