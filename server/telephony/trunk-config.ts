import { BlockList, isIP } from 'node:net';
import { resolve } from 'node:path';

export function readTrunkConfig(env: NodeJS.ProcessEnv = process.env) {
  const missing: string[] = [], errors: string[] = [];
  const required = ['ALIYUN_TRUNK_HOST', 'ALIYUN_TRUNK_CALLER', 'ALIYUN_TRUNK_TO_TEMPLATE', 'ALIYUN_TRUNK_FROM_TEMPLATE',
    'ALIYUN_SIP_SOURCE_CIDRS', 'ALIYUN_RTP_SOURCE_CIDRS', 'ECS_PUBLIC_IP', 'SIPHON_CONTROL_TOKEN', 'PILOT_TEST_PHONE'];
  for (const name of required) if (!env[name]?.trim()) missing.push(name);
  const host = env.ALIYUN_TRUNK_HOST?.trim() ?? '';
  const port = Number(env.ALIYUN_TRUNK_PORT || 8000);
  if (host && isIP(host) !== 4) errors.push('ALIYUN_TRUNK_HOST 需为售后确认的IPv4 SBC地址');
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('ALIYUN_TRUNK_PORT 无效');
  if (env.ALIYUN_TRUNK_TRANSPORT && env.ALIYUN_TRUNK_TRANSPORT !== 'udp') errors.push('此工程入口只支持已确认的UDP直连');
  if (env.ALIYUN_TRUNK_AUTH !== 'ip') missing.push('ALIYUN_TRUNK_AUTH=ip（售后确认IP鉴权）');
  if (env.ALIYUN_TRUNK_LATE_OFFER_CONFIRMED !== 'true') missing.push('ALIYUN_TRUNK_LATE_OFFER_CONFIRMED=true（售后确认支持无SDP INVITE/late offer）');
  if (env.ALIYUN_TRUNK_ANSWER_IS_CUSTOMER_CONFIRMED !== 'true') missing.push('ALIYUN_TRUNK_ANSWER_IS_CUSTOMER_CONFIRMED=true（售后确认200应答代表客户接通）');
  const caller = env.ALIYUN_TRUNK_CALLER?.trim() ?? '';
  if (caller && !/^\+?\d{5,20}$/.test(caller)) errors.push('ALIYUN_TRUNK_CALLER 必须为售后批准的完整主叫');
  const phone = env.PILOT_TEST_PHONE?.trim() ?? '';
  if (phone && !/^(?:\+86|0086)?1[3-9]\d{9}$/.test(phone)) errors.push('PILOT_TEST_PHONE 无效');
  if (env.ECS_PUBLIC_IP && isIP(env.ECS_PUBLIC_IP) !== 4) errors.push('ECS_PUBLIC_IP 无效');
  for (const name of ['ALIYUN_SIP_SOURCE_CIDRS', 'ALIYUN_RTP_SOURCE_CIDRS']) {
    if (!env[name]) continue;
    try {
      const block = new BlockList();
      for (const cidr of env[name]!.split(',')) {
        const [ip, bits] = cidr.trim().split('/'); const prefix = Number(bits);
        if (isIP(ip) !== 4 || !/^\d+$/.test(bits ?? '') || prefix < 1 || prefix > 32) throw new Error();
        block.addSubnet(ip, prefix, 'ipv4');
      }
      if (name === 'ALIYUN_SIP_SOURCE_CIDRS' && host && !block.check(host, 'ipv4')) errors.push('SBC地址不在已确认信令来源网段内');
    } catch { errors.push(`${name} 需为有效IPv4 CIDR列表且不能使用0.0.0.0/0`); }
  }
  const replace = (template: string, actualPhone: string) => template.replace(/\{([^}]+)\}/g, (_match, key: string) => (({
    phone: actualPhone.replace(/^(?:\+86|0086)/, ''), e164: '+86' + actualPhone.replace(/^(?:\+86|0086)/, ''),
    caller, host, port: String(port), public_ip: env.ECS_PUBLIC_IP ?? '',
  } as Record<string, string>)[key] ?? `{${key}}`));
  const toTemplate = env.ALIYUN_TRUNK_TO_TEMPLATE ?? '', fromTemplate = env.ALIYUN_TRUNK_FROM_TEMPLATE ?? '';
  if (toTemplate && !/\{(?:phone|e164)\}/.test(toTemplate)) errors.push('TO模板必须包含{phone}或{e164}，不能硬编码被叫');
  for (const [name, template] of [['ALIYUN_TRUNK_TO_TEMPLATE', toTemplate], ['ALIYUN_TRUNK_FROM_TEMPLATE', fromTemplate]]) {
    if (template && !/^sip:[a-zA-Z0-9_.+%~-]+@[a-zA-Z0-9.-]+(?::\d+)?(?:;[a-zA-Z0-9_=.-]+)*$/.test(replace(template, phone || '13800000000'))) errors.push(`${name} 非法或含未知占位符`);
  }
  let headers: Record<string, string> = {};
  try {
    headers = JSON.parse(env.ALIYUN_TRUNK_HEADERS_JSON || '{}');
    if (!headers || typeof headers !== 'object' || Array.isArray(headers) || Object.keys(headers).length > 16 || Object.entries(headers).some(([key, value]) =>
      !/^(?:X-[\w-]+|P-Asserted-Identity|P-Preferred-Identity)$/.test(key) || typeof value !== 'string' || /[\r\n\0]/.test(value))) throw new Error();
  } catch { errors.push('ALIYUN_TRUNK_HEADERS_JSON 需为售后确认的自定义身份头，不得覆盖Via/Route/Contact'); }
  const mediaPort = Number(env.PILOT_MEDIA_PORT || 3001);
  if (!Number.isInteger(mediaPort) || mediaPort < 1 || mediaPort > 65535) errors.push('PILOT_MEDIA_PORT 无效');
  const controlUrl = env.SIPHON_CONTROL_URL || 'ws://127.0.0.1:9092/control/ws';
  try { const url = new URL(controlUrl); if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search) throw new Error(); } catch { errors.push('SIPHON_CONTROL_URL 无效'); }
  return { missing, errors, config: missing.length || errors.length ? undefined : {
    testPhone: phone, host, port, caller, headers, to: replace(toTemplate, phone), from: replace(fromTemplate, phone),
    controlUrl, controlToken: env.SIPHON_CONTROL_TOKEN!, mediaPort,
    recordingRoot: resolve(env.PILOT_GATEWAY_RECORDINGS_PATH || 'data/gateway-recordings'),
    gatewayRecordingRoot: env.SIPHON_RECORDINGS_PATH || '/recordings',
  } };
}
export type TrunkConfig = NonNullable<ReturnType<typeof readTrunkConfig>['config']>;
