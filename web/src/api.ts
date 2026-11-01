export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
    throw new Error(String(record.error ?? record.message ?? `请求失败（${response.status}）`));
  }
  return result as T;
}
export function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
