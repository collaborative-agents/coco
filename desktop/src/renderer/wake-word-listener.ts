export type WakeWordAudioFrameHandler = (frame: Uint8Array) => void;
export type WakeWordInterruptionHandler = (reason: string) => void;

/**
 * Captures microphone audio for the local wake-word model.
 *
 * The browser audio graph resamples to 16 kHz. Frames are converted to PCM16,
 * sent directly to the main process, and never recorded or retained here.
 */
export class WakeWordListener {
  private generation = 0;

  private stream: MediaStream | null = null;

  private context: AudioContext | null = null;

  private processor: ScriptProcessorNode | null = null;

  private source: MediaStreamAudioSourceNode | null = null;

  private sink: GainNode | null = null;

  private starting: Promise<void> | null = null;

  get active(): boolean {
    return this.stream !== null;
  }

  async start(
    onFrame: WakeWordAudioFrameHandler,
    onInterrupted?: WakeWordInterruptionHandler,
  ): Promise<void> {
    if (this.stream) return;
    if (this.starting) {
      await this.starting;
      if (!this.stream) await this.start(onFrame, onInterrupted);
      return;
    }
    this.generation += 1;
    const { generation } = this;
    this.starting = this.startInternal(
      generation,
      onFrame,
      onInterrupted,
    ).finally(() => {
      this.starting = null;
    });
    await this.starting;
  }

  private async startInternal(
    generation: number,
    onFrame: WakeWordAudioFrameHandler,
    onInterrupted?: WakeWordInterruptionHandler,
  ): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Wake-word capture may run concurrently with QuickTime or another
        // recorder. WebRTC voice processing can monopolize the macOS audio
        // unit, so use the raw shared microphone path here.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    if (generation !== this.generation) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    const context = new AudioContext({ sampleRate: 16_000 });
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(2048, 1, 1);
    const sink = context.createGain();
    let silentFrames = 0;
    let interruptionReported = false;
    const reportInterruption = (reason: string) => {
      if (interruptionReported || generation !== this.generation) return;
      interruptionReported = true;
      onInterrupted?.(reason);
    };
    const [track] = stream.getAudioTracks();
    if (track) {
      track.onended = () => reportInterruption('microphone track ended');
      track.onmute = () => reportInterruption('microphone track muted');
    }
    sink.gain.value = 0;
    processor.onaudioprocess = (event) => {
      const { inputBuffer } = event;
      const samples = inputBuffer.getChannelData(0);
      const pcm = new Int16Array(samples.length);
      let peak = 0;
      for (let index = 0; index < samples.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, samples[index]));
        peak = Math.max(peak, Math.abs(sample));
        pcm[index] = sample < 0 ? sample * 32768 : sample * 32767;
      }
      silentFrames = peak < 0.0001 ? silentFrames + 1 : 0;
      if (silentFrames >= 24) {
        reportInterruption('microphone is delivering silent audio');
      }
      onFrame(new Uint8Array(pcm.buffer));
    };
    source.connect(processor);
    processor.connect(sink);
    sink.connect(context.destination);
    if (context.state === 'suspended') await context.resume();

    this.stream = stream;
    this.context = context;
    this.source = source;
    this.processor = processor;
    this.sink = sink;
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.stream?.getAudioTracks().forEach((track) => {
      track.onended = null;
      track.onmute = null;
    });
    this.processor?.disconnect();
    if (this.processor) this.processor.onaudioprocess = null;
    this.source?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    const { context } = this;
    this.stream = null;
    this.context = null;
    this.source = null;
    this.processor = null;
    this.sink = null;
    if (context && context.state !== 'closed') await context.close();
  }
}
