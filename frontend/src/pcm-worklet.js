class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs?.[0]?.[0];
    if (channel && channel.length) {
      this.port.postMessage(channel.slice(0));
    }
    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
