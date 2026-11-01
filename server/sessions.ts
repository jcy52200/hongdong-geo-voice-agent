import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buildPrompt, getOpening } from './prompt.js';
import { createSeedSession, SeedPeer, type SeedEvent } from './seed.js';
import { buildInitialIntroduction } from './sales-script.js';
import { consumeInitialQuickReply, createInitialQuickReplyState, type InitialQuickReplyState } from './quick-reply.js';
import type { ControlRequest, ControlResult } from '../shared/model-config.js';
import { Simulation } from './simulation.js';
import { Store } from './store.js';
import type { ServerEvent, SessionStatus } from './types.js';

const clientSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().trim().min(1).max(2000) }),
  z.object({ type: z.literal('audio'), audio: z.string().max(900) }),
  z.object({ type: z.literal('playback_done') }),
  z.object({ type: z.literal('mute'), muted: z.boolean() }),
  z.object({ type: z.literal('finish') }),
]);
interface LiveCall {
  client: WebSocket;
  peer?: SeedPeer;
  sim?: Simulation;
  openingAudioDone: boolean;
  muted: boolean;
  timer?: ReturnType<typeof setTimeout>;
  deadline?: ReturnType<typeof setTimeout>;
  partials: Map<string, string>;
  currentAsr?: string;
  currentChat?: string;
  cloudId?: string;
  pendingControl?: { id: string; expected: string; timer: ReturnType<typeof setTimeout>; resolve: (result: ControlResult) => void; reject: (error: Error) => void };
  pendingTools: Map<string, unknown>;
  controls: { createdAt: string; action: string; result: string }[];
  replacementText: string;
  quickReply: InitialQuickReplyState;
  quickReplyAudio?: {
    requestId: string; text: string; questionId?: string; responseId?: string;
    ttsStarted: boolean; interrupted: boolean; fallbackInserted: boolean; completed: boolean;
    providerTextIds: Set<string>; uncorrelatedText: boolean;
  };
}
export class ControlError extends Error { constructor(message: string, public status = 409) { super(message); } }
export class SessionManager {
  private live = new Map<string, LiveCall>();
  constructor(private store: Store, private key: string,
    private seedUrl?: string, private webSearchKey = '') {}
  attach(id: string, client: WebSocket) {
    const session = this.store.session(id);
    if (!session || session.status !== 'created' || this.live.has(id)) {
      client.send(JSON.stringify({ type: 'error', message: '该会话不存在或已经连接，请新建测试' }));
      client.close(1008); return;
    }
    if (session.mode === 'seed' && !this.key) {
      this.store.status(id, 'failed', '未配置 SEED_API_KEY');
      client.send(JSON.stringify({ type: 'error', message: '请在服务端 .env 配置 SEED_API_KEY 后重启' }));
      client.close(1008); return;
    }
    const call: LiveCall = { client, openingAudioDone: false, muted: false, partials: new Map(), pendingTools: new Map(), controls: [], replacementText: '', quickReply: createInitialQuickReplyState() };
    this.live.set(id, call);
    this.send(id, { type: 'session', session });
    client.on('message', (data, binary) => {
      if (!this.live.has(id)) return;
      try {
        if (binary) throw new Error('只接受 JSON 文本消息');
        const result = clientSchema.safeParse(JSON.parse(data.toString()));
        if (!result.success) throw new Error('消息格式错误');
        const message = result.data;
        if (message.type === 'finish') { this.finish(id); return; }
        if (message.type === 'playback_done') {
          if (this.store.session(id)?.status === 'opening' && call.openingAudioDone) {
            clearTimeout(call.timer);
            this.state(id, 'active');
            if (!call.muted) call.peer?.send({ type: 'input_audio_unmute.commit' });
          }
          return;
        }
        if (message.type === 'mute') {
          call.muted = message.muted;
          if (this.store.session(id)?.status === 'active') {
            call.peer?.send({ type: message.muted ? 'input_audio_mute.commit' : 'input_audio_unmute.commit' });
          }
          return;
        }
        if (this.store.session(id)?.status !== 'active') return;
        if (message.type === 'audio' && session.mode === 'seed' && !call.muted) {
          if (!/^[A-Za-z0-9+/]+={0,2}$/.test(message.audio) || Buffer.from(message.audio, 'base64').length !== 640) {
            throw new Error('上行音频每帧需为16kHz单声道PCM16、20ms/640字节');
          }
          call.peer?.send({ type: 'input_audio_buffer.append', audio: message.audio });
        }
        if (message.type === 'text' && call.sim) {
          this.send(id, { type: 'transcript', transcript: this.store.transcript(id, randomUUID(), 'AsrText', message.text, true) });
          const response = call.sim.reply(message.text);
          this.send(id, { type: 'transcript', transcript: this.store.transcript(id, randomUUID(), 'ChatText', response.text, true) });
          if (response.done) this.finish(id);
        }
      } catch (error) {
        this.send(id, { type: 'error', message: error instanceof Error ? error.message : '无法处理消息' });
      }
    });
    client.on('error', () => this.fail(id, '浏览器连接异常，会话已结束'));
    client.on('close', () => this.fail(id, '浏览器已断开，会话已结束'));
    call.deadline = setTimeout(() => this.fail(id, '单次测试已达到10分钟上限，请新建测试'), 10 * 60 * 1000);
    call.deadline.unref();
    if (session.mode === 'simulation') {
      call.sim = new Simulation(session.customer);
      this.send(id, { type: 'transcript', transcript: this.store.transcript(id, 'opening', 'ChatText', getOpening(session.configSnapshot, session.customer), true) });
      this.state(id, 'active');
    } else {
      this.state(id, 'connecting');
      call.timer = setTimeout(() => this.fail(id, 'SeedDuplex 初始化超时，请检查密钥、开通权限与网络'), 20000);
      call.timer.unref();
      call.peer = new SeedPeer(session, this.key, e => this.providerEvent(id, e), message => this.fail(id, message), this.seedUrl, this.webSearchKey);
    }
  }
  private providerEvent(id: string, event: SeedEvent) {
    const call = this.live.get(id);
    if (!call) return;
    const status = this.store.session(id)?.status;
    const opening = status === 'opening';
    // Never persist base64 audio. Preserve provider correlation IDs for text and lifecycle events.
    const safeEvent = this.redact(event);
    if (event.type !== 'response.output_audio.delta') this.store.event(id, event.type, safeEvent);
    if (event.type === 'session.created' && status === 'connecting') {
      this.store.answered(id);
      call.cloudId = event.session?.id || id;
      clearTimeout(call.timer);
      this.state(id, 'opening');
      call.peer?.send({ type: 'input_audio_mute.commit' });
      const currentSession = this.store.session(id)!;
      const openingText = getOpening(currentSession.configSnapshot, currentSession.customer);
      this.send(id, { type: 'transcript', transcript: this.store.transcript(id, 'opening', 'ChatText', openingText, true) });
      call.peer?.send({ type: 'speech_text_buffer.commit', text: openingText });
      call.timer = setTimeout(() => this.fail(id, '开场播放未确认完成，请检查音频权限并重新测试'), 60000);
      call.timer.unref();
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.failed') {
      // An unintelligible item is recoverable; it must not terminate the entire call.
      if (event.item_id) call.partials.delete(`asr:${event.item_id}`);
      call.currentAsr = undefined;
      return;
    }
    if (event.type === 'error') {
      const detail = String(safeEvent.error?.message ?? safeEvent.message ?? safeEvent.error?.code ?? safeEvent.code ?? '未知错误').slice(0, 240);
      if (call.pendingControl) {
        clearTimeout(call.pendingControl.timer);
        call.pendingControl.reject(new ControlError(`控制请求被服务端拒绝：${detail}`, 502));
        call.pendingControl = undefined;
        return;
      }
      this.fail(id, `SeedDuplex：${detail}`); return;
    }
    if (event.type === call.pendingControl?.expected) {
      const pending = call.pendingControl;
      clearTimeout(pending.timer); call.pendingControl = undefined;
      pending.resolve({ requestId: pending.id, status: 'confirmed', message: `服务端已确认 ${event.type}`, event: safeEvent });
    }
    if (event.type === 'response.function_call_arguments.done') {
      const items = Array.isArray(safeEvent.items) ? safeEvent.items : safeEvent.items ? [safeEvent.items] : [];
      for (const item of items) if (typeof item.call_id === 'string') call.pendingTools.set(item.call_id, item);
    }
    if (event.type === 'session.closed') { this.finish(id); return; }
    if (status === 'active') this.quickReplyAudioEvent(id, event);
    if (status === 'active' && /^response\.output_(?:text|audio)\.(?:started|delta|done)$/.test(event.type)) {
      call.quickReply.outputSeen = true;
    }
    if (event.type === 'response.output_audio.delta' && typeof event.delta === 'string') {
      this.send(id, { type: 'audio', audio: event.delta, rate: 24000 }); return;
    }
    if (event.type === 'response.output_audio.done') {
      // status_code can also encode exit intent; error events own failure handling.
      if (opening) call.openingAudioDone = true;
      this.send(id, { type: 'audio_done', opening }); return;
    }
    if (opening) return; // No ASR/interrupt/duplicate ChatText can affect the fixed greeting.
    if (event.type === 'conversation.item.input_audio_transcription.started') {
      call.currentAsr = event.item_id || randomUUID();
      if (status === 'active') call.quickReply.firstItemId ??= call.currentAsr;
      this.send(id, { type: 'interrupted' }); // Match official demo: drop local queued playback on user speech.
    }
    if (event.type === 'response.canceled') this.send(id, { type: 'interrupted' });
    const asr = event.type.startsWith('conversation.item.input_audio_transcription.');
    const chat = event.type.startsWith('response.output_text.');
    if (!asr && !chat) return;
    const delta = event.type.endsWith('.delta');
    const final = event.type.endsWith('.done') || event.type.endsWith('.completed');
    if (!delta && !final) return;
    const key = asr ? (event.item_id || call.currentAsr || randomUUID()) : (event.response_id || call.currentChat || randomUUID());
    if (asr) call.currentAsr = key; else call.currentChat = key;
    if (asr && status === 'active') call.quickReply.firstItemId ??= key;
    const partialKey = `${asr ? 'asr' : 'chat'}:${key}`;
    let text = call.partials.get(partialKey) ?? '';
    if (delta) text += typeof event.delta === 'string' ? event.delta : '';
    else text = event.transcript ?? event.text ?? text;
    if (typeof text !== 'string') text = '';
    call.partials.set(partialKey, text);
    const quickAudio = call.quickReplyAudio;
    const replaceFallback = Boolean(chat && quickAudio?.fallbackInserted && quickAudio.responseId === key && !quickAudio.providerTextIds.has(key));
    if (chat && quickAudio && text) {
      if (typeof event.response_id === 'string' && event.response_id) quickAudio.providerTextIds.add(event.response_id);
      else quickAudio.uncorrelatedText = true;
    }
    if (text) this.send(id, { type: 'transcript', transcript: this.store.transcript(id, key,
      asr ? 'AsrText' : 'ChatText', text, final, event.event_id, replaceFallback) });
    if (final) {
      if (asr && status === 'active') this.initialQuickReply(id, key, text);
      call.partials.delete(partialKey);
      if (asr) call.currentAsr = undefined; else call.currentChat = undefined;
    }
  }
  private quickReplyAudioEvent(id: string, event: SeedEvent) {
    const call = this.live.get(id);
    const audio = call?.quickReplyAudio;
    if (!call || !audio) return;
    if (event.type === 'conversation.item.input_audio_transcription.started' || event.type === 'response.canceled') {
      if (!audio.completed && !audio.interrupted) {
        audio.interrupted = true;
        this.store.event(id, 'local.quick_reply.interrupted', { requestId: audio.requestId, responseId: audio.responseId, reason: event.type });
      }
      return;
    }
    if (audio.interrupted || audio.completed) return;
    if (event.type === 'response.output_audio.started') {
      // The official replacement example identifies its TTS as chat_tts_text.
      // Its started response_id may be empty; delta supplies the stable ID.
      if (event.tts_type !== 'chat_tts_text') return;
      if (typeof event.question_id !== 'string' || !event.question_id) return;
      if (audio.questionId && audio.questionId !== event.question_id) { audio.interrupted = true; return; }
      audio.ttsStarted = true; audio.questionId = event.question_id;
      return;
    }
    if (!audio.ttsStarted || audio.uncorrelatedText || typeof event.response_id !== 'string' || !event.response_id
      || event.question_id !== audio.questionId) return;
    if (event.type === 'response.output_audio.delta') {
      if (typeof event.delta !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(event.delta)) return;
      const bytes = Buffer.from(event.delta, 'base64');
      if (!bytes.length || bytes.length % 2) return;
      audio.responseId ??= event.response_id;
      if (audio.responseId !== event.response_id || audio.providerTextIds.has(event.response_id) || audio.fallbackInserted) return;
      audio.fallbackInserted = true;
      this.send(id, { type: 'transcript', transcript: this.store.transcript(id, event.response_id, 'ChatText', audio.text, false, event.event_id) });
      this.store.event(id, 'local.quick_reply.transcript', { requestId: audio.requestId, responseId: audio.responseId, source: 'replacement_tts', final: false });
    }
    if (event.type === 'response.output_audio.done' && audio.fallbackInserted && audio.responseId === event.response_id
      && !audio.providerTextIds.has(event.response_id)) {
      audio.completed = true;
      this.send(id, { type: 'transcript', transcript: this.store.transcript(id, event.response_id, 'ChatText', audio.text, true, event.event_id) });
      this.store.event(id, 'local.quick_reply.transcript', { requestId: audio.requestId, responseId: audio.responseId, source: 'replacement_tts', final: true });
    }
  }
  private initialQuickReply(id: string, itemId: string, text: string) {
    const call = this.live.get(id);
    const session = this.store.session(id);
    if (!call || !session || session.status !== 'active') return;
    const decision = consumeInitialQuickReply(call.quickReply, itemId, text, {
      enabled: session.configSnapshot.quickReplyEnabled !== false, muted: call.muted,
      controlPending: Boolean(call.pendingControl), replacementPending: Boolean(call.replacementText),
      toolPending: call.pendingTools.size > 0,
    });
    if (!decision) return;
    if (!decision.trigger) {
      this.store.event(id, 'local.quick_reply.skipped', { itemId, reason: decision.reason });
      return;
    }
    const event = { type: 'speech_text_buffer.replacement.commit', event_id: randomUUID(), text: buildInitialIntroduction(session.customer, session.configSnapshot.quickReplyText) };
    // Official replacement bypasses free-form response generation. ASR completed
    // already means end-of-speech: do not force-commit input or cancel a response.
    this.store.event(id, 'local.quick_reply.requested', this.redact({ itemId, reason: decision.reason, event }));
    call.quickReplyAudio = { requestId: event.event_id, text: event.text, ttsStarted: false, interrupted: false,
      fallbackInserted: false, completed: false, providerTextIds: new Set(), uncorrelatedText: false };
    call.peer?.send(event);
    // No ChatText before real matching audio. Provider output_text takes priority
    // over the audio-only fallback and reuses its response ID to avoid duplicates.
  }
  private redact<T>(value: T): T {
    const walk = (item: any): any => {
      if (typeof item === 'string') {
        for (const secret of [this.key, this.webSearchKey]) if (secret) item = item.split(secret).join('[redacted]');
        return item;
      }
      if (Array.isArray(item)) return item.map(walk);
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, item]) => [key, walk(item)]));
      return item;
    };
    return walk(value);
  }
  runtime(id: string) {
    const call = this.live.get(id);
    return { active: Boolean(call), status: this.store.session(id)?.status, muted: call?.muted ?? false,
      controls: call?.controls ?? [], replacementChars: call?.replacementText.length ?? 0, pendingTools: [...(call?.pendingTools.values() ?? [])] };
  }
  async control(id: string, command: ControlRequest): Promise<ControlResult> {
    const call = this.live.get(id);
    const session = this.store.session(id);
    if (!call || !session || session.mode !== 'seed') throw new ControlError('请先建立一通 SeedDuplex 语音测试');
    if (session.status !== 'active') throw new ControlError('请等待首句实际播放完成后再操作');
    if (call.pendingControl) throw new ControlError('上一条控制请求仍在等待服务端确认');
    const requestId = randomUUID();
    let event: Record<string, any>;
    let expected = '';
    switch (command.action) {
      case 'apply_config': {
        const config = this.store.config();
        if (config.modelOptions?.dialog?.extra?.enable_volc_websearch && !this.webSearchKey) throw new ControlError('请在 .env 配置 SEED_WEBSEARCH_API_KEY 后重启', 400);
        event = createSeedSession({ ...session, id: call.cloudId ?? id, configSnapshot: config, prompt: buildPrompt(session.customer, config) }, this.webSearchKey, true);
        expected = 'session.updated'; break;
      }
      case 'greet': event = { type: 'speech_text_buffer.commit', text: getOpening({ ...session.configSnapshot, opening: command.text }, session.customer) }; break;
      case 'replace': event = { type: 'speech_text_buffer.replacement.commit', text: command.text }; break;
      case 'replacement_append':
        if (call.replacementText.length + command.text.length > 8000) throw new ControlError('分片累计文本超过8000字符', 400);
        call.replacementText += command.text;
        event = { type: 'speech_text_buffer.replacement.append', text: command.text }; break;
      case 'replacement_commit':
        if (call.replacementText.length + command.text.length > 8000) throw new ControlError('分片累计文本超过8000字符', 400);
        event = { type: 'speech_text_buffer.replacement.commit', text: command.text }; break;
      case 'cancel': call.replacementText = ''; event = { type: 'response.cancel' }; expected = 'response.canceled'; this.send(id, { type: 'interrupted' }); break;
      case 'commit_input': event = { type: 'input_audio_buffer.commit' }; expected = 'input_audio_buffer.committed'; break;
      case 'mute':
        call.muted = command.muted;
        event = { type: command.muted ? 'input_audio_mute.commit' : 'input_audio_unmute.commit' };
        this.send(id, { type: 'input_state', muted: command.muted }); break;
      case 'context':
        event = command.event;
        expected = ({ 'conversation.item.create': 'conversation.item.added', 'conversation.item.update': '',
          'conversation.item.retrieve': 'conversation.item.retrieved', 'conversation.item.delete': 'conversation.item.deleted' })[command.event.type];
        break;
      case 'tool_result':
        if (!call.pendingTools.has(command.callId)) throw new ControlError('找不到该 call_id 对应的待回传函数调用', 400);
        event = { type: 'conversation.item.create', items: [{ call_id: command.callId, role: 'tool', content: [{ type: 'input_text', text: command.text }] }] };
        expected = 'conversation.item.added'; break;
    }
    event.event_id = requestId;
    call.quickReply.operatorControlled = true;
    if (call.quickReplyAudio && ['greet', 'replace', 'replacement_append', 'replacement_commit', 'cancel'].includes(command.action)) {
      call.quickReplyAudio.interrupted = true;
    }
    this.store.event(id, 'local.control.requested', this.redact({ action: command.action, event }));
    const result: Promise<ControlResult> = expected ? new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (call.pendingControl?.id === requestId) { call.pendingControl = undefined; reject(new ControlError('8秒内未收到服务端确认；请求可能已发送，请先核对回包再重试', 504)); }
      }, 8000);
      timer.unref();
      call.pendingControl = { id: requestId, expected, timer, resolve, reject };
    }) : Promise.resolve({ requestId, status: 'sent', message: '已发送；该事件没有独立确认，请结合播报与服务端事件核对' });
    call.peer!.send(event);
    if (command.action === 'greet' || command.action === 'replace' || command.action === 'replacement_commit') {
      const text = command.action === 'replacement_commit' ? call.replacementText + command.text : String(event.text);
      call.replacementText = '';
      if (text) this.send(id, { type: 'transcript', transcript: this.store.transcript(id, `operator:${requestId}`, 'ChatText', text, true) });
    }
    try {
      const response = await result;
      if (command.action === 'tool_result') call.pendingTools.delete(command.callId);
      call.controls.unshift({ createdAt: new Date().toISOString(), action: command.action, result: response.message });
      call.controls.length = Math.min(call.controls.length, 30);
      this.store.event(id, 'local.control.result', response);
      return response;
    } catch (error) {
      call.controls.unshift({ createdAt: new Date().toISOString(), action: command.action, result: error instanceof Error ? error.message : '控制失败' });
      call.controls.length = Math.min(call.controls.length, 30);
      this.store.event(id, 'local.control.failed', { requestId, action: command.action, message: error instanceof Error ? error.message : '控制失败' });
      throw error;
    }
  }
  private send(id: string, event: ServerEvent) {
    const client = this.live.get(id)?.client;
    if (client?.readyState === WebSocket.OPEN) {
      if (client.bufferedAmount > 2 * 1024 * 1024) {
        this.store.status(id, 'failed', '播放端音频积压，测试已结束');
        this.cleanup(id); return;
      }
      client.send(JSON.stringify(event));
    }
  }
  private state(id: string, status: SessionStatus, error?: string) {
    this.store.status(id, status, error);
    this.send(id, { type: 'state', status });
  }
  private cleanup(id: string) {
    const call = this.live.get(id);
    if (!call) return;
    this.live.delete(id);
    if (call.pendingControl) {
      clearTimeout(call.pendingControl.timer);
      call.pendingControl.reject(new ControlError('通话已结束，控制请求不再等待确认', 410));
      call.pendingControl = undefined;
    }
    clearTimeout(call.timer); clearTimeout(call.deadline);
    call.peer?.close();
    call.client.close(1000);
  }
  finish(id: string) {
    const session = this.store.session(id);
    if (!session || session.status === 'completed' || session.status === 'failed') return;
    this.state(id, 'completed');
    this.cleanup(id);
  }
  fail(id: string, message: string) {
    if (!this.live.has(id)) return;
    this.send(id, { type: 'error', message });
    this.state(id, 'failed', message);
    this.cleanup(id);
  }
  shutdown() { for (const id of this.live.keys()) this.fail(id, '本地服务已停止'); }
}
