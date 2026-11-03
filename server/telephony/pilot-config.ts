import { resolve } from 'node:path';
import { readAliyunCccConfig } from './aliyun-config.js';

/** Environment-only diagnostics. Report missing field names, never credential values. */
export function readPilotConfig(env: NodeJS.ProcessEnv = process.env) {
  const ccc = readAliyunCccConfig(env);
  const missing = [...ccc.missing]; const errors = [...ccc.errors];
  const required = ['ALIYUN_SIP_EXTENSION', 'ALIYUN_SIP_PASSWORD', 'ALIYUN_SIP_DOMAIN', 'ALIYUN_SIP_REGISTRAR_URI',
    'ALIYUN_SIP_AUTH_USER', 'ALIYUN_SIP_SOURCE_CIDRS', 'SIPHON_CONTROL_TOKEN', 'PILOT_TEST_PHONE'] as const;
  for (const key of required) if (!env[key]?.trim()) missing.push(key);
  const controlUrl = env.SIPHON_CONTROL_URL?.trim() || 'ws://127.0.0.1:9092/control/ws';
  try { const url = new URL(controlUrl); if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search) errors.push('SIPHON_CONTROL_URL 格式无效'); }
  catch { errors.push('SIPHON_CONTROL_URL 格式无效'); }
  const mediaPort = Number(env.PILOT_MEDIA_PORT || '3001');
  if (!Number.isInteger(mediaPort) || mediaPort < 1 || mediaPort > 65535) errors.push('PILOT_MEDIA_PORT 无效');
  if (env.ALIYUN_SIP_REGISTRAR_URI && !/^sips?:[A-Za-z0-9.-]+:\d+$/.test(env.ALIYUN_SIP_REGISTRAR_URI)) errors.push('ALIYUN_SIP_REGISTRAR_URI 需填已确认的注册域名与明确端口，不带URI参数；TLS由网关transport配置');
  const testPhone = env.PILOT_TEST_PHONE?.trim() ?? '';
  if (testPhone && !/^(?:\+86|0086)?1[3-9]\d{9}$/.test(testPhone)) errors.push('PILOT_TEST_PHONE 应为已获准测试的中国大陆手机');
  const recordingRoot = resolve(env.PILOT_GATEWAY_RECORDINGS_PATH || 'data/gateway-recordings');
  const gatewayRecordingRoot = env.SIPHON_RECORDINGS_PATH?.trim() || '/recordings';
  if (!gatewayRecordingRoot.startsWith('/') || /[\r\n\0]/.test(gatewayRecordingRoot)) errors.push('SIPHON_RECORDINGS_PATH 无效');
  const result = { missing: [...new Set(missing)], errors };
  if (!ccc.config || missing.length || errors.length) return { ...result, config: undefined };
  return { ...result, config: { ccc: ccc.config, controlUrl, controlToken: env.SIPHON_CONTROL_TOKEN!,
    extension: env.ALIYUN_SIP_EXTENSION!, testPhone, mediaPort, mediaBaseUrl: env.PILOT_MEDIA_BASE_URL?.trim(), recordingRoot, gatewayRecordingRoot } };
}
export type PilotConfig = NonNullable<ReturnType<typeof readPilotConfig>['config']>;
