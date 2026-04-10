class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pendingFlushToken = "";
    this.port.onmessage = (event) => {
      const msg = event?.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "flush" && msg.token) {
        this.pendingFlushToken = String(msg.token);
      }
    };
  }

  process(inputs) {
    const channel = inputs?.[0]?.[0];
    if (channel && channel.length) {
      this.port.postMessage(channel.slice(0));
      return true;
    }
    if (this.pendingFlushToken) {
      this.port.postMessage({ type: "flush-ack", token: this.pendingFlushToken });
      this.pendingFlushToken = "";
    }
    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
