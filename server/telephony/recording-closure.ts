import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

/** Trusted native callback receipt, not a guess based on WAV size or elapsed time. */
export async function readRecordingClosure(root: string, sessionId: string, sipCallId: string, recordingId: string) {
  if (!/^[a-f0-9-]{36}$/.test(sessionId)) return undefined;
  let handle;
  try {
    handle = await open(join(root, `${sessionId}.wav.closed.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > 8192) return undefined;
    const data = JSON.parse(await handle.readFile('utf8'));
    if (data.schema !== 1 || data.source !== 'rtpengine.on_recording_finished' || data.call_id !== sipCallId
      || data.recording_id !== recordingId || data.path !== join(root, `${sessionId}.wav`) || typeof data.reason !== 'string') return undefined;
    return { recording_id: recordingId, path: data.path as string, reason: data.reason as string };
  } catch { return undefined; }
  finally { await handle?.close(); }
}
