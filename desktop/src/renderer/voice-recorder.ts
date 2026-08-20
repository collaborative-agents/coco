export type VoiceRecorderStatus = 'listening' | 'speaking';

export interface VoiceRecording {
  wavBase64: string;
  durationMs: number;
}

export interface ActiveVoiceRecorder {
  done: Promise<VoiceRecording>;
  stop: () => void;
  cancel: () => void;
}

interface VoiceRecorderOptions {
  silenceMs?: number;
  maxDurationMs?: number;
  onStatus?: (status: VoiceRecorderStatus) => void;
}

const TARGET_SAMPLE_RATE = 16_000;
const MIN_RMS = 0.012;
const SPEECH_CONFIRM_MS = 120;
const PRE_ROLL_MS = 300;
const DEFAULT_END_OF_SPEECH_SILENCE_MS = 2_500;

function resample(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_SAMPLE_RATE) return input;
  const outputLength = Math.max(
    1,
    Math.round(input.length * (TARGET_SAMPLE_RATE / inputRate)),
  );
  const output = new Float32Array(outputLength);
  const ratio = inputRate / TARGET_SAMPLE_RATE;
  for (let i = 0; i < outputLength; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;
    output[i] = input[left] * (1 - fraction) + input[right] * fraction;
  }
  return output;
}

function encodePcmWav(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const writeText = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(
      44 + i * 2,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true,
    );
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function startVoiceRecorder(
  options: VoiceRecorderOptions = {},
): Promise<ActiveVoiceRecorder> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone recording is not available on this computer.');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      // Use CoreAudio's shared raw capture path so a screen recorder such as
      // QuickTime can record the same microphone during a Coco voice demo.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  const AudioContextClass = window.AudioContext;
  const context = new AudioContextClass();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const mutedOutput = context.createGain();
  mutedOutput.gain.value = 0;
  source.connect(processor);
  processor.connect(mutedOutput);
  mutedOutput.connect(context.destination);

  // Leave enough room for a natural pause between clauses. One second was
  // prone to submitting while the user was still forming the next phrase.
  const silenceMs = options.silenceMs ?? DEFAULT_END_OF_SPEECH_SILENCE_MS;
  const maxDurationMs = options.maxDurationMs ?? 30_000;
  const chunks: Float32Array[] = [];
  let sampleCount = 0;
  let speechStartSample: number | null = null;
  let speechCandidateMs = 0;
  let lastVoiceAt = performance.now();
  let noiseRms = 0.004;
  let noiseFrames = 0;
  let settled = false;
  let timer: number | undefined;
  let resolveDone: (recording: VoiceRecording) => void = () => {};
  let rejectDone: (error: Error) => void = () => {};

  const done = new Promise<VoiceRecording>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const cleanup = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    processor.onaudioprocess = null;
    source.disconnect();
    processor.disconnect();
    mutedOutput.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    context.close().catch(() => {});
  };

  const finish = (requireSpeech: boolean) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (sampleCount === 0 || (requireSpeech && speechStartSample === null)) {
      rejectDone(
        new Error(
          "I didn't hear any speech. Try again a little closer to the microphone.",
        ),
      );
      return;
    }
    const start = speechStartSample ?? 0;
    const joined = new Float32Array(sampleCount);
    let offset = 0;
    chunks.forEach((chunk) => {
      joined.set(chunk, offset);
      offset += chunk.length;
    });
    const selected = joined.subarray(Math.min(start, joined.length - 1));
    const resampled = resample(selected, context.sampleRate);
    resolveDone({
      wavBase64: bytesToBase64(encodePcmWav(resampled)),
      durationMs: (resampled.length / TARGET_SAMPLE_RATE) * 1_000,
    });
  };

  const cancel = () => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectDone(new Error('Voice recording cancelled.'));
  };

  processor.onaudioprocess = (event) => {
    if (settled) return;
    const input = event.inputBuffer.getChannelData(0);
    const copy = new Float32Array(input);
    chunks.push(copy);
    const chunkStart = sampleCount;
    sampleCount += copy.length;

    let energy = 0;
    for (let i = 0; i < copy.length; i += 1) energy += copy[i] * copy[i];
    const rms = Math.sqrt(energy / Math.max(1, copy.length));
    const chunkMs = (copy.length / context.sampleRate) * 1_000;
    if (speechStartSample === null && rms < 0.03) {
      noiseRms = (noiseRms * noiseFrames + rms) / (noiseFrames + 1);
      noiseFrames += 1;
    }
    const threshold = Math.max(MIN_RMS, noiseRms * 2.5);
    const now = performance.now();
    if (rms >= threshold) {
      speechCandidateMs += chunkMs;
      lastVoiceAt = now;
      if (
        speechStartSample === null &&
        speechCandidateMs >= SPEECH_CONFIRM_MS
      ) {
        const preRollSamples = Math.round(
          (PRE_ROLL_MS / 1_000) * context.sampleRate,
        );
        speechStartSample = Math.max(0, chunkStart - preRollSamples);
        options.onStatus?.('speaking');
      }
    } else {
      speechCandidateMs = 0;
    }
    if (speechStartSample !== null && now - lastVoiceAt >= silenceMs) {
      finish(false);
    }
  };

  options.onStatus?.('listening');
  timer = window.setTimeout(() => finish(true), maxDurationMs);
  return {
    done,
    stop: () => finish(false),
    cancel,
  };
}
