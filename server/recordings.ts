import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Recording } from '../shared/session.js';

export const MAX_RECORDING_BYTES = 25 * 1024 * 1024;
export const MAX_GATEWAY_RECORDING_BYTES = 128 * 1024 * 1024;

export interface RecordingMetadata extends Recording {}

export class RecordingError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const formats: Record<string, { extension: string; valid: (body: Buffer) => boolean }> = {
  'audio/webm': { extension: 'webm', valid: body => body.length >= 4 && body.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) },
  'audio/ogg': { extension: 'ogg', valid: body => body.length >= 4 && body.subarray(0, 4).toString('ascii') === 'OggS' },
  'audio/mp4': { extension: 'm4a', valid: body => body.length >= 12 && body.subarray(4, 8).toString('ascii') === 'ftyp' },
};

/** Archives browser audio and completed gateway WAV files outside the public web bundle. */
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
    const normalized = mimeType.split(';', 1)[0].trim().toLowerCase();
    return join(this.directory, `${sessionId.toLowerCase()}.${normalized === 'audio/wav' ? 'wav' : this.format(normalized).extension}`);
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

  /** Called server-side only after the gateway's RecordingFinished event. Never accepts an HTTP upload. */
  async importGatewayWav(sessionId: string, filePath: string, trustedDirectory: string, options: { incomplete?: boolean } = {}): Promise<RecordingMetadata> {
    const destination = this.path(sessionId, 'audio/wav');
    const source = resolve(filePath);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let body: Buffer;
    try {
      const root = await realpath(trustedDirectory);
      const original = await lstat(source);
      if (!original.isFile() || original.isSymbolicLink()) throw new RecordingError('线路录音必须是受信目录内的普通文件。');
      const canonical = await realpath(source);
      const within = relative(root, canonical);
      if (!within || within === '..' || within.startsWith('../') || isAbsolute(within)) throw new RecordingError('线路录音不在受信目录内。');
      handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat();
      if (!before.isFile() || before.dev !== original.dev || before.ino !== original.ino) throw new RecordingError('线路录音在导入前发生变化。');
      if (!before.size) throw new RecordingError('线路录音为空。');
      if (before.size > MAX_GATEWAY_RECORDING_BYTES) throw new RecordingError('线路录音不能超过 128 MiB。', 413);
      const chunks: Buffer[] = []; let size = 0;
      // Bounded reads also protect against a file that grows after the first stat.
      while (true) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_GATEWAY_RECORDING_BYTES + 1 - size));
        const read = await handle.read(chunk, 0, chunk.length, size);
        if (!read.bytesRead) break;
        size += read.bytesRead;
        if (size > MAX_GATEWAY_RECORDING_BYTES) throw new RecordingError('线路录音不能超过 128 MiB。', 413);
        chunks.push(chunk.subarray(0, read.bytesRead));
      }
      const after = await handle.stat();
      const final = await lstat(canonical);
      if (before.size !== size || after.size !== size || after.mtimeMs !== before.mtimeMs || final.isSymbolicLink()
        || final.dev !== before.dev || final.ino !== before.ino || await realpath(source) !== canonical) {
        throw new RecordingError('线路录音尚未稳定，请等待网关完成录音。');
      }
      body = Buffer.concat(chunks, size);
    } catch (error) {
      if (error instanceof RecordingError) throw error;
      // Do not expose gateway paths or filesystem error details to a caller.
      throw new RecordingError('无法读取已完成的线路录音，请检查受信目录和文件权限。');
    } finally { await handle?.close(); }
    const audio = inspectPcm16Wav(body);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.${sessionId.toLowerCase()}-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
      await rename(temporary, destination);
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
      throw new RecordingError('线路录音归档失败，请检查存储目录权限。', 500);
    }
    return { mimeType: 'audio/wav', bytes: body.length, createdAt: new Date().toISOString(), url: `/api/sessions/${sessionId.toLowerCase()}/recording`,
      source: 'siphon', channels: audio.channels, sampleRate: audio.sampleRate, duration: audio.duration, incomplete: options.incomplete ?? false };
  }
}

/** RIFF PCM16 only. Validate actual chunk boundaries, sample layout and recorded duration. */
function inspectPcm16Wav(body: Buffer): { channels: number; sampleRate: number; duration: number } {
  const reject = (): never => { throw new RecordingError('线路录音须为有效的 PCM16 WAV（单/双声道，受支持采样率）。', 415); };
  if (body.length < 44 || body.toString('ascii', 0, 4) !== 'RIFF' || body.toString('ascii', 8, 12) !== 'WAVE' || body.readUInt32LE(4) !== body.length - 8) return reject();
  let format: { channels: number; sampleRate: number; blockAlign: number; byteRate: number } | undefined;
  let dataBytes: number | undefined;
  for (let offset = 12; offset < body.length;) {
    if (offset + 8 > body.length) return reject();
    const name = body.toString('ascii', offset, offset + 4);
    const length = body.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > body.length) return reject();
    if (name === 'fmt ') {
      if (format || length < 16 || body.readUInt16LE(start) !== 1 || body.readUInt16LE(start + 14) !== 16) return reject();
      format = { channels: body.readUInt16LE(start + 2), sampleRate: body.readUInt32LE(start + 4), byteRate: body.readUInt32LE(start + 8), blockAlign: body.readUInt16LE(start + 12) };
    } else if (name === 'data') {
      if (dataBytes !== undefined || !length) return reject();
      dataBytes = length;
    }
    offset = start + length + (length % 2);
    if (offset > body.length) return reject();
  }
  if (!format || dataBytes === undefined || ![1, 2].includes(format.channels) || ![8000, 16000, 24000, 32000, 44100, 48000].includes(format.sampleRate)
    || format.blockAlign !== format.channels * 2 || format.byteRate !== format.sampleRate * format.blockAlign || dataBytes % format.blockAlign !== 0) return reject();
  return { channels: format.channels, sampleRate: format.sampleRate, duration: dataBytes / format.byteRate };
}
