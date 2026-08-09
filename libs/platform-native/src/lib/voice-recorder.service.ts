import { Injectable } from '@angular/core';
import { WAVEFORM_BUCKETS, downsampleWaveform } from '@trinity/util/matrix';

/** A finished recording: the encoded audio plus its duration and waveform. */
export interface VoiceRecording {
  blob: Blob;
  /** Recorded length in milliseconds. */
  durationMs: number;
  /** Downsampled amplitude waveform (MSC1767, `[0, 1024]`). */
  waveform: number[];
  /** Encoded MIME type (e.g. `audio/webm`). */
  mimeType: string;
}

/** Preferred container/codec order for the recording, best interop first. */
const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/webm',
  'audio/mp4',
];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
    return undefined;
  }
  return PREFERRED_MIME_TYPES.find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
}

/**
 * Records a voice clip from the microphone via `MediaRecorder` (web + the
 * Capacitor/Electron WebViews, gated by the OS mic permission) and derives its
 * waveform by decoding the clip with an `AudioContext`. Stateful across a single
 * recording: {@link start} then {@link stop} (which resolves the clip) or
 * {@link cancel} (which discards it). Not for concurrent recordings.
 */
@Injectable({ providedIn: 'root' })
export class VoiceRecorderService {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;

  /** Whether this platform can record (MediaRecorder + getUserMedia present). */
  get supported(): boolean {
    return (
      typeof MediaRecorder !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia
    );
  }

  /** Whether a recording is currently in progress. */
  get recording(): boolean {
    return this.recorder !== null;
  }

  /**
   * Prompt for the mic and begin recording. Rejects when recording isn't supported
   * or the permission is denied. A no-op if already recording.
   */
  async start(): Promise<void> {
    if (this.recorder) {
      return;
    }
    if (!this.supported) {
      throw new Error('Voice recording isn’t available on this device.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(
      stream,
      mimeType ? { mimeType } : undefined,
    );
    this.stream = stream;
    this.chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.chunks.push(event.data);
      }
    };
    // The recorder can die on its own (permission revoked mid-record, the device
    // grabbed by another app). Nothing else clears the handle, and `start()` no-ops
    // while it is set, so a stale one would wedge voice messaging for the session.
    recorder.onerror = () => {
      if (this.recorder === recorder) {
        this.teardown();
      }
    };
    this.recorder = recorder;
    recorder.start();
    this.startedAt = performance.now();
  }

  /**
   * Stop recording and resolve the clip with its duration + waveform, or null when
   * nothing was recording. The tracks are released regardless.
   */
  async stop(): Promise<VoiceRecording | null> {
    const recorder = this.recorder;
    if (!recorder) {
      return null;
    }
    const durationMs = Math.max(
      0,
      Math.round(performance.now() - this.startedAt),
    );
    let blob: Blob;
    try {
      // Already inactive — the tracks ended under us, so no 'stop' event is coming
      // and calling stop() would throw InvalidStateError. Take whatever was captured.
      if (recorder.state === 'inactive') {
        blob = this.collect(recorder);
      } else {
        blob = await new Promise<Blob>((resolve) => {
          recorder.addEventListener(
            'stop',
            () => resolve(this.collect(recorder)),
            {
              once: true,
            },
          );
          try {
            recorder.stop();
          } catch {
            // Raced into 'inactive' between the check and the call; the event will
            // never fire, so resolve from the chunks we already have.
            resolve(this.collect(recorder));
          }
        });
      }
    } finally {
      // On every exit path, or the mic stays live and `start()` no-ops forever after.
      this.teardown();
    }
    const waveform = await computeWaveform(blob);
    return { blob, durationMs, waveform, mimeType: blob.type || 'audio/webm' };
  }

  /** Abort the current recording, discarding the clip and releasing the mic. */
  cancel(): void {
    const recorder = this.recorder;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // Already stopping; teardown still releases the tracks below.
      }
    }
    this.teardown();
  }

  private collect(recorder: MediaRecorder): Blob {
    return new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' });
  }

  private teardown(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }
}

/** Decode a clip and downsample its first channel to a waveform; [] on failure. */
async function computeWaveform(blob: Blob): Promise<number[]> {
  const globals = globalThis as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const AudioCtx = globals.AudioContext ?? globals.webkitAudioContext;
  if (!AudioCtx) {
    return [];
  }
  const context = new AudioCtx();
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    return downsampleWaveform(buffer.getChannelData(0), WAVEFORM_BUCKETS);
  } catch {
    return [];
  } finally {
    void context.close();
  }
}
