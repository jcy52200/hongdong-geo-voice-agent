/**
 * Streaming PCM16LE mono sample-rate conversion. A windowed-sinc low-pass
 * precedes decimation; the phase and filter history survive arbitrary chunks.
 * The 32-sample lookahead is flushed once at a completed playback boundary.
 */
export class StreamingPcm16Resampler {
  private samples: number[] = [];
  private base = 0;
  private inputSamples = 0;
  private outputSamples = 0;
  private finished = false;
  private readonly halfWidth = 32;
  private readonly cutoff: number;

  constructor(readonly inputRate = 24000, readonly outputRate = 16000) {
    if (!Number.isInteger(inputRate) || !Number.isInteger(outputRate) || inputRate < 8000 || outputRate < 8000) {
      throw new Error('PCM sample rates must be integers >= 8000');
    }
    this.cutoff = 0.45 * Math.min(1, outputRate / inputRate);
  }

  push(pcm: Buffer): Buffer {
    if (this.finished) throw new Error('PCM resampler has been flushed');
    if (pcm.length % 2) throw new Error('PCM16LE requires complete 16-bit samples');
    for (let offset = 0; offset < pcm.length; offset += 2) this.samples.push(pcm.readInt16LE(offset));
    this.inputSamples += pcm.length / 2;
    return this.render(false);
  }

  flush(): Buffer {
    if (this.finished) return Buffer.alloc(0);
    this.finished = true;
    const result = this.render(true);
    this.samples = [];
    return result;
  }

  private render(flush: boolean): Buffer {
    const values: number[] = [];
    const target = Math.ceil(this.inputSamples * this.outputRate / this.inputRate);
    while (this.outputSamples < target) {
      const position = this.outputSamples * this.inputRate / this.outputRate;
      if (!flush && Math.floor(position) + this.halfWidth >= this.inputSamples) break;
      let value = 0;
      let weightSum = 0;
      const first = Math.ceil(position - this.halfWidth);
      const last = Math.floor(position + this.halfWidth);
      for (let index = first; index <= last; index++) {
        const distance = index - position;
        const window = 0.5 + 0.5 * Math.cos(Math.PI * distance / this.halfWidth);
        const argument = 2 * this.cutoff * distance;
        const sinc = argument === 0 ? 1 : Math.sin(Math.PI * argument) / (Math.PI * argument);
        const weight = 2 * this.cutoff * sinc * window;
        weightSum += weight;
        if (index >= 0 && index < this.inputSamples) value += this.samples[index - this.base] * weight;
      }
      values.push(Math.max(-32768, Math.min(32767, Math.round(value / weightSum))));
      this.outputSamples++;
    }
    // Retain only samples needed by the next output position's FIR support.
    const earliest = Math.max(0, Math.ceil(this.outputSamples * this.inputRate / this.outputRate - this.halfWidth));
    const remove = Math.max(0, Math.min(this.samples.length, earliest - this.base));
    if (remove) { this.samples = this.samples.slice(remove); this.base += remove; }
    const result = Buffer.allocUnsafe(values.length * 2);
    for (let index = 0; index < values.length; index++) result.writeInt16LE(values[index], index * 2);
    return result;
  }
}

/** Retains at most one incomplete frame; finish pads its final partial frame. */
export class Pcm16Framer {
  private remainder: Buffer = Buffer.alloc(0);

  constructor(readonly frameBytes = 640) {
    if (!Number.isInteger(frameBytes) || frameBytes < 2 || frameBytes % 2) throw new Error('Invalid PCM frame size');
  }

  push(pcm: Buffer): Buffer[] {
    if (pcm.length % 2) throw new Error('PCM16LE requires complete 16-bit samples');
    const source = this.remainder.length ? Buffer.concat([this.remainder, pcm]) : pcm;
    const count = Math.floor(source.length / this.frameBytes);
    const frames: Buffer[] = [];
    for (let index = 0; index < count; index++) frames.push(Buffer.from(source.subarray(index * this.frameBytes, (index + 1) * this.frameBytes)));
    this.remainder = Buffer.from(source.subarray(count * this.frameBytes));
    return frames;
  }

  finish(): Buffer[] {
    if (!this.remainder.length) return [];
    const frame = Buffer.alloc(this.frameBytes);
    this.remainder.copy(frame);
    this.remainder = Buffer.alloc(0);
    return [frame];
  }
}
