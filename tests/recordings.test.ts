import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MAX_RECORDING_BYTES, RecordingError, Recordings } from '../server/recordings.js';
import { LocalAudio } from '../web/src/audio.js';

const id = '73e4052a-b447-4123-9dcb-22736edf4cf9';

test('原始录音按通话隔离保存，元数据不暴露本地路径，重复上传原子替换', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'geo-recordings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const recordings = new Recordings(directory);
  const body = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('browser webm recording')]);
  const metadata = await recordings.save(id, body, 'audio/webm;codecs=opus');
  assert.deepEqual({ ...metadata, createdAt: undefined }, {
    mimeType: 'audio/webm', bytes: body.length, createdAt: undefined, url: `/api/sessions/${id}/recording`,
  });
  assert.ok(Number.isFinite(Date.parse(metadata.createdAt)));
  assert.deepEqual(await readFile(recordings.path(id, metadata.mimeType)), body);
  assert.equal((await stat(recordings.path(id, metadata.mimeType))).mode & 0o777, 0o600);
  const updated = Buffer.concat([body, Buffer.from(' final chunk')]);
  await recordings.save(id, updated, 'audio/webm');
  assert.deepEqual(await readFile(recordings.path(id, 'audio/webm')), updated);
  assert.deepEqual(await readdir(directory), [`${id}.webm`]);
});

test('支持浏览器 MP4 和 Ogg，并拒绝伪造格式、空录音、超限和路径穿越', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'geo-recordings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const recordings = new Recordings(directory);
  const ogg = Buffer.from('OggS\0\0OpusHead');
  const mp4 = Buffer.from([0, 0, 0, 16, ...Buffer.from('ftypM4A ')]);
  assert.equal((await recordings.save(id, ogg, 'audio/ogg; codecs=opus')).mimeType, 'audio/ogg');
  assert.equal((await recordings.save(id, mp4, 'audio/mp4')).mimeType, 'audio/mp4');
  const rejects = (promise: Promise<unknown>, status: number) => assert.rejects(promise,
    error => error instanceof RecordingError && error.status === status);
  await rejects(recordings.save('../escape', ogg, 'audio/ogg'), 400);
  await rejects(recordings.save(id, Buffer.alloc(0), 'audio/ogg'), 400);
  await rejects(recordings.save(id, Buffer.from('<html>'), 'audio/webm'), 415);
  await rejects(recordings.save(id, ogg, 'text/html'), 415);
  await rejects(recordings.save(id, ogg, 'constructor'), 415);
  await rejects(recordings.save(id, Buffer.alloc(MAX_RECORDING_BYTES + 1), 'audio/ogg'), 413);
  assert.throws(() => recordings.path(`${id}/../other`, 'audio/webm'), RecordingError);
  assert.deepEqual((await readdir(directory)).sort(), [`${id}.m4a`, `${id}.ogg`]);
});

function fakeMedia(t: test.TestContext, microphone?: Promise<unknown>) {
  class Node {
    connections: Node[] = [];
    connect(target: Node) { this.connections.push(target); return target; }
    disconnect() { this.connections = []; }
  }
  const microphoneTrack = { stopped: false, stop() { this.stopped = true; } };
  const mixTrack = { stopped: false, stop() { this.stopped = true; } };
  const mic = { getTracks: () => [microphoneTrack] };
  const input = new Node();
  const gainNodes: Array<Node & { gain: { value: number } }> = [];
  const destination = Object.assign(new Node(), { stream: { getTracks: () => [mixTrack] }, channelCount: 2 });
  class Context {
    state = 'running';
    destination = new Node();
    currentTime = 0;
    audioWorklet = { addModule: async () => {} };
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createMediaStreamSource() { return input; }
    createMediaStreamDestination() { return destination; }
    createGain() {
      const gain = Object.assign(new Node(), { gain: { value: 1 } });
      gainNodes.push(gain); return gain;
    }
  }
  class Worklet extends Node {
    port = { postMessage() {}, close() {}, onmessage: undefined };
  }
  class Recorder {
    static isTypeSupported(type: string) { return type.startsWith('audio/webm'); }
    state = 'inactive';
    mimeType: string;
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void;
    constructor(_stream: unknown, options: { mimeType: string }) { this.mimeType = options.mimeType; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      // Real MediaRecorder emits final data asynchronously, after stop() returns.
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0])]) });
        this.onstop?.();
      });
    }
  }
  const globals: Record<string, unknown> = {
    AudioContext: Context, AudioWorkletNode: Worklet, MediaRecorder: Recorder,
    navigator: { mediaDevices: { getUserMedia: () => microphone ?? Promise.resolve(mic) } },
    window: { setTimeout, clearTimeout },
  };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  return { mic, microphoneTrack, mixTrack, gainNodes };
}

test('录音等待最终音频片段，停止和关闭可重复，麦克风静音与上行一致', async t => {
  const media = fakeMedia(t);
  const audio = new LocalAudio();
  await audio.prepare(() => {});
  const microphoneRecordingGain = media.gainNodes[1];
  assert.equal(microphoneRecordingGain.gain.value, 0, '锁定首句期间不保存麦克风内容');
  audio.setInputEnabled(true);
  assert.equal(microphoneRecordingGain.gain.value, 1);
  audio.setInputEnabled(false);
  assert.equal(microphoneRecordingGain.gain.value, 0);
  const done = audio.stopRecording();
  assert.equal(audio.stopRecording(), done);
  audio.close();
  audio.close();
  assert.equal(media.microphoneTrack.stopped, true, '关闭时立即释放真实麦克风');
  assert.equal(audio.context.state, 'running', '最终片段发出前保留混音上下文');
  const recording = await done;
  assert.equal(recording?.blob.size, 5, '最终 dataavailable 片段没有丢失');
  assert.equal(recording?.mimeType, 'audio/webm;codecs=opus');
  assert.equal(media.mixTrack.stopped, true);
  assert.equal(audio.context.state, 'closed');
});

test('等待麦克风授权期间取消，迟到的设备流立即停止且不会启动录音', async t => {
  let grant!: (stream: unknown) => void;
  const permission = new Promise(resolve => { grant = resolve; });
  const media = fakeMedia(t, permission);
  const audio = new LocalAudio();
  const ready = audio.prepare(() => {});
  await Promise.resolve();
  audio.close();
  grant(media.mic);
  await ready;
  assert.equal(media.microphoneTrack.stopped, true);
  assert.equal(await audio.stopRecording(), null);
  assert.equal(media.gainNodes.length, 0);
  assert.equal(audio.context.state, 'closed');
});
