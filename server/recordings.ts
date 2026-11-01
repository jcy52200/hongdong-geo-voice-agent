import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const MAX_RECORDING_BYTES = 25 * 1024 * 1024;

export interface RecordingMetadata {
  mimeType: string;
  bytes: number;
  createdAt: string;
  url: string;
}

export class RecordingError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const formats: Record<string, { extension: string; valid: (body: Buffer) => boolean }> = {
  'audio/webm': { extension: 'webm', valid: body => body.length >= 4 && body.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) },
  'audio/ogg': { extension: 'ogg', valid: body => body.length >= 4 && body.subarray(0, 4).toString('ascii') === 'OggS' },
  'audio/mp4': { extension: 'm4a', valid: body => body.length >= 12 && body.subarray(4, 8).toString('ascii') === 'ftyp' },
};

/** Stores genuine browser audio outside the public web bundle. */
export class Recordings {
  readonly directory: string;

  constructor(directory: string) { this.directory = resolve(directory); }

  private format(mimeType: string) {
    const normalized = mimeType.split(';', 1)[0].trim().toLowerCase();
    if (!Object.hasOwn(formats, normalized)) throw new RecordingError('仅支持 WebM、Ogg 或 MP4 格式的音频录音。', 415);
    const format = formats[normalized];
    return { ...format, mimeType: normalized };
  }

  path(sessionId: string, mimeType: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
      throw new RecordingError('通话标识无效。');
    }
    return join(this.directory, `${sessionId.toLowerCase()}.${this.format(mimeType).extension}`);
  }

  async save(sessionId: string, body: Buffer, mimeType: string): Promise<RecordingMetadata> {
    const destination = this.path(sessionId, mimeType);
    const format = this.format(mimeType);
    if (!Buffer.isBuffer(body) || body.length === 0) throw new RecordingError('录音为空，未保存任何音频。');
    if (body.length > MAX_RECORDING_BYTES) throw new RecordingError('录音不能超过 25 MiB。', 413);
    if (!format.valid(body)) throw new RecordingError('录音内容与声明的音频格式不符。', 415);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.${sessionId.toLowerCase()}-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return {
      mimeType: format.mimeType, bytes: body.length, createdAt: new Date().toISOString(),
      url: `/api/sessions/${sessionId.toLowerCase()}/recording`,
    };
  }
}
