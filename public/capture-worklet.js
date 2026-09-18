// Mic capture worklet: downsamples the device rate to 16 kHz PCM16 and posts chunks.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions.targetRate || 16000;
    this.ratio = sampleRate / this.targetRate;
    this.pos = 0;
    this.buf = [];
    this.muted = false;
    this.port.onmessage = (e) => {
      if (e.data?.type === 'mute') this.muted = e.data.value;
    };
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    let peak = 0;
    // Linear-interpolated resample down to the target rate.
    while (this.pos < input.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = input[i];
      const b = i + 1 < input.length ? input[i + 1] : input[input.length - 1];
      const s = this.muted ? 0 : a + (b - a) * frac;
      if (s > peak) peak = s;
      this.buf.push(Math.max(-1, Math.min(1, s)));
      this.pos += this.ratio;
    }
    this.pos -= input.length;

    // Emit ~60 ms frames.
    const frame = (this.targetRate * 60) / 1000;
    while (this.buf.length >= frame) {
      const chunk = this.buf.splice(0, frame);
      const pcm = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) pcm[i] = chunk[i] < 0 ? chunk[i] * 0x8000 : chunk[i] * 0x7fff;
      this.port.postMessage({ pcm: pcm.buffer, level: peak }, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
