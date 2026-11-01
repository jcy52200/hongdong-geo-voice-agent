/* Streaming linear resampler. Emits 20 ms, 16 kHz mono, little-endian PCM16. */
class PCM16Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.samples = [];
    this.position = 0;
    this.frame = new Int16Array(320);
    this.frameOffset = 0;
    this.port.onmessage = event => {
      this.enabled = Boolean(event.data.enabled);
      this.samples = [];
      this.position = 0;
      this.frameOffset = 0;
    };
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!this.enabled || !channel) return true;
    for (let index = 0; index < channel.length; index++) this.samples.push(channel[index]);
    const step = sampleRate / 16000;
    while (this.position + 1 < this.samples.length) {
      const low = Math.floor(this.position);
      const fraction = this.position - low;
      const value = Math.max(-1, Math.min(1, this.samples[low] + (this.samples[low + 1] - this.samples[low]) * fraction));
      this.frame[this.frameOffset++] = Math.round(value * (value < 0 ? 32768 : 32767));
      if (this.frameOffset === 320) {
        // DataView makes the wire byte order independent of platform endianness.
        const buffer = new ArrayBuffer(640);
        const view = new DataView(buffer);
        for (let index = 0; index < 320; index++) view.setInt16(index * 2, this.frame[index], true);
        this.port.postMessage(buffer, [buffer]);
        this.frameOffset = 0;
      }
      this.position += step;
    }
    // Keep the boundary sample and any fractional/overshooting position. Dropping
    // the entire 128-sample block would skew timing at 44.1/48 kHz input rates.
    const consumed = Math.min(Math.floor(this.position), this.samples.length - 1);
    this.samples.splice(0, consumed);
    this.position -= consumed;
    return true;
  }
}
registerProcessor('pcm16-capture', PCM16Capture);
