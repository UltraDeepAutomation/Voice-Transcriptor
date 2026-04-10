/**
 * PCM capture AudioWorklet processor.
 *
 * Posts each render quantum as a Float32Array to the main thread on its
 * message port, and replies to control messages on the same port.
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
    this.port.onmessage = (event) => {
      const msg = event?.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "flush" && msg.token) {
        // Post ack synchronously. All PCM messages posted during previous
        // process() ticks are already queued on the port before this ack,
        // so the main-thread listener observes them first. This is the
        // correct semantics for a "drain" barrier.
        this.port.postMessage({ type: "flush-ack", token: String(msg.token) });
      }
    };
  }

  process(inputs) {
    const channel = inputs?.[0]?.[0];
    if (channel && channel.length) {
      this.port.postMessage(channel.slice(0));
    }
    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
