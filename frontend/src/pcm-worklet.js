/**
 * PCM capture AudioWorklet processor.
 *
 * Batches render quanta into Float32Array chunks before posting to the
 * main thread. Posting every 128-sample quantum produces hundreds of UI
 * thread messages per second; batching keeps capture lossless while
 * reducing renderer scheduling pressure.
 *
 * Control messages:
 *   {type: "flush", token: string}  → processor immediately acknowledges
 *                                     with {type: "flush-ack", token}. The
 *                                     ack guarantees that all PCM frames
 *                                     posted BEFORE the ack have been
 *                                     handed to the port (ordering is
 *                                     preserved within a MessagePort).
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.pendingSamples = 0;
    this.maxPendingSamples = 2048;
    this.port.onmessage = (event) => {
      const msg = event?.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "flush" && msg.token) {
        this.flushPending();
        // Post ack synchronously. All PCM messages posted during previous
        // process() ticks are already queued on the port before this ack,
        // so the main-thread listener observes them first. This is the
        // correct semantics for a "drain" barrier.
        this.port.postMessage({ type: "flush-ack", token: String(msg.token) });
      }
    };
  }

  flushPending() {
    if (!this.pendingSamples) return;
    if (this.pending.length === 1) {
      this.port.postMessage(this.pending[0]);
    } else {
      const merged = new Float32Array(this.pendingSamples);
      let offset = 0;
      for (const chunk of this.pending) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      this.port.postMessage(merged);
    }
    this.pending = [];
    this.pendingSamples = 0;
  }

  process(inputs) {
    const channel = inputs?.[0]?.[0];
    if (channel && channel.length) {
      const copy = channel.slice(0);
      this.pending.push(copy);
      this.pendingSamples += copy.length;
      if (this.pendingSamples >= this.maxPendingSamples) {
        this.flushPending();
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
