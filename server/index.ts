import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createApp } from './app.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 需为1至65535的整数');
const runtime = createApp({ databasePath: resolve(process.env.GEO_DATABASE_PATH ?? 'data/geo.sqlite'), apiKey: process.env.SEED_API_KEY?.trim(), webSearchKey: process.env.SEED_WEBSEARCH_API_KEY?.trim() });
runtime.server.listen(port, '127.0.0.1', () => console.log(`泓动引擎本地工作台 API：http://127.0.0.1:${port}`));
runtime.server.on('error', error => { console.error(`本地服务启动失败：${error.message}`); process.exitCode = 1; runtime.store.close(); });
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await runtime.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
