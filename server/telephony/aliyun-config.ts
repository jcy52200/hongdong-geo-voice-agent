/** CCC API credentials are RAM credentials. A SIP extension/password cannot replace them. */
export interface AliyunCccConfig {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken?: string;
  regionId: string;
  endpoint: string;
  instanceId: string;
  userId: string;
  caller: string;
  deviceId: string;
  timeoutMs: number;
}

export interface AliyunCccConfigResult {
  config?: AliyunCccConfig;
  missing: string[];
  errors: string[];
}

const ENV_FIELDS = {
  accessKeyId: 'ALIBABA_CLOUD_ACCESS_KEY_ID',
  accessKeySecret: 'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
  instanceId: 'ALIYUN_CCC_INSTANCE_ID',
  userId: 'ALIYUN_CCC_USER_ID',
  caller: 'ALIYUN_CCC_CALLER',
} as const;

/** Reports field names only; never includes the value of an invalid setting. */
export function readAliyunCccConfig(env: NodeJS.ProcessEnv = process.env): AliyunCccConfigResult {
  const missing: string[] = [];
  const errors: string[] = [];
  const values = Object.fromEntries(Object.entries(ENV_FIELDS).map(([field, name]) => {
    const raw = env[name] ?? '';
    const value = raw.trim();
    if (!value) missing.push(name);
    if (/[\r\n\0]/.test(raw)) errors.push(`${name} 格式无效。`);
    return [field, value];
  })) as Record<keyof typeof ENV_FIELDS, string>;
  const regionId = env.ALIYUN_CCC_REGION_ID?.trim() || 'cn-shanghai';
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(regionId)) errors.push('ALIYUN_CCC_REGION_ID 格式无效。');
  const endpoint = env.ALIYUN_CCC_ENDPOINT?.trim() || `ccc.${regionId}.aliyuncs.com`;
  if (!isAliyunCccEndpoint(endpoint)) errors.push('ALIYUN_CCC_ENDPOINT 必须是 CCC 的阿里云服务域名。');
  const deviceId = env.ALIYUN_CCC_DEVICE_ID?.trim() || 'hongdong-pilot';
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(deviceId)) errors.push('ALIYUN_CCC_DEVICE_ID 格式无效。');
  // The documented API UserId is agent@instance; requiring it prevents accidentally using a SIP extension.
  if (values.userId && !/^[^\s@]+@[^\s@]+$/.test(values.userId)) errors.push('ALIYUN_CCC_USER_ID 应为坐席 ID（如 agent@实例），不能填写 SIP 分机号。');
  if (values.caller && !/^\+?\d{5,20}$/.test(values.caller)) errors.push('ALIYUN_CCC_CALLER 应为该坐席有权使用的阿里平台外呼号码。');
  const timeoutMs = Number(env.ALIYUN_CCC_TIMEOUT_MS?.trim() || '10000');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) errors.push('ALIYUN_CCC_TIMEOUT_MS 必须为 100–60000 的整数。');
  const securityToken = env.ALIBABA_CLOUD_SECURITY_TOKEN?.trim() || undefined;
  if (/[\r\n\0]/.test(env.ALIBABA_CLOUD_SECURITY_TOKEN ?? '')) errors.push('ALIBABA_CLOUD_SECURITY_TOKEN 格式无效。');
  if (missing.length || errors.length) return { missing, errors };
  return { config: { ...values, regionId, endpoint, deviceId, timeoutMs, securityToken }, missing, errors };
}

export function isAliyunCccEndpoint(endpoint: string): boolean {
  return /^(?:ccc|ccc\.[a-z][a-z0-9-]{1,39})\.aliyuncs\.com$/.test(endpoint);
}
