/** The voice core consumes PCM; wire protocols and playback live in adapters. */
export interface PlaybackSegment {
  id: string;
  responseId?: string;
  opening: boolean;
}

export type MediaInput =
  | { type: 'audio'; audio: Buffer }
  | { type: 'text'; text: string }
  | { type: 'playback_started'; playbackId: string }
  | { type: 'playback_drained'; playbackId: string }
  | { type: 'mute'; muted: boolean }
  | { type: 'finish' }
  | { type: 'close' }
  | { type: 'error'; message: string };

/**
 * Input: PCM16LE mono 16 kHz, 20 ms / 640 bytes. Output: PCM16LE mono 24 kHz.
 * An adapter converts its wire format and owns its bounded playback queue.
 * Drain must refer to a completed segment, never just a successful WS write.
 * false means the output could not be accepted; the core ends the session.
 */
export interface MediaPort {
  readonly capabilities: { canConfirmPlaybackDrain: boolean };
  onEvent(handler: (event: MediaInput) => void): () => void;
  writeAudio(pcm: Buffer, segment: PlaybackSegment): boolean;
  completePlayback(segment: PlaybackSegment): boolean;
  clearPlayback(): boolean;
  close(): void;
}
