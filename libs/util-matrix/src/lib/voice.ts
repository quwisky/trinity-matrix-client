import { MsgType } from 'matrix-js-sdk';
import type { EncryptedFileInfo } from './media.model';

/**
 * Voice messages (MSC3245) — an `m.audio` marked with an empty
 * `org.matrix.msc3245.voice` object and an `org.matrix.msc1767.audio` extension
 * carrying the duration and a downsampled waveform. This module is pure (no SDK/DI):
 * it computes the waveform and builds the send content.
 */

/** Number of amplitude buckets in a rendered/sent waveform. */
export const WAVEFORM_BUCKETS = 60;
/** MSC1767 waveform amplitudes are integers in `[0, 1024]`. */
const WAVEFORM_MAX = 1024;

/** The MSC3245 voice marker + MSC1767 audio extension keys. */
export const MSC3245_VOICE = 'org.matrix.msc3245.voice';
export const MSC1767_AUDIO = 'org.matrix.msc1767.audio';

/**
 * Reduce raw PCM samples to `buckets` peak amplitudes normalized to `[0, 1024]`
 * (MSC1767). Each bucket takes the maximum absolute sample in its slice, then all
 * buckets are scaled to the loudest peak so a quiet recording still fills the bars.
 */
export function downsampleWaveform(
  samples: ArrayLike<number>,
  buckets = WAVEFORM_BUCKETS,
): number[] {
  if (samples.length === 0 || buckets <= 0) {
    return [];
  }
  const bucketSize = samples.length / buckets;
  const peaks: number[] = [];
  let loudest = 0;
  for (let i = 0; i < buckets; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.min(
      samples.length,
      Math.max(start + 1, Math.floor((i + 1) * bucketSize)),
    );
    let peak = 0;
    for (let j = start; j < end; j++) {
      const amplitude = Math.abs(samples[j]);
      if (amplitude > peak) {
        peak = amplitude;
      }
    }
    peaks.push(peak);
    if (peak > loudest) {
      loudest = peak;
    }
  }
  const scale = loudest > 0 ? WAVEFORM_MAX / loudest : 0;
  return peaks.map((peak) => Math.round(peak * scale));
}

/** The fields {@link voiceMessageContent} needs from an uploaded audio clip. */
export interface VoiceUpload {
  /** `content.url` for a plaintext upload, else null. */
  mxc: string | null;
  /** `content.file` for an encrypted upload, else null. */
  file: EncryptedFileInfo | null;
  /** Recorded MIME type (e.g. `audio/webm`). */
  mimeType: string;
  /** Clip size in bytes. */
  size: number;
}

/**
 * Build the `m.audio` content for a recorded voice message: the standard file/info
 * fields plus the MSC3245 voice marker and the MSC1767 audio extension (duration +
 * waveform), so voice-aware clients (Element et al.) render it as a voice message.
 */
export function voiceMessageContent(
  upload: VoiceUpload,
  durationMs: number,
  waveform: number[],
) {
  return {
    msgtype: MsgType.Audio,
    body: 'Voice message',
    ...(upload.file ? { file: upload.file } : { url: upload.mxc }),
    info: {
      mimetype: upload.mimeType,
      size: upload.size,
      duration: durationMs,
    },
    [MSC3245_VOICE]: {},
    [MSC1767_AUDIO]: { duration: durationMs, waveform },
  };
}
