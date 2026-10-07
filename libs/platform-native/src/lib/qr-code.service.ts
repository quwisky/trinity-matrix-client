import { Injectable } from '@angular/core';
import type encodeQr from 'qr';
import type decodeQr from 'qr/decode.js';

interface QrCodec {
  readonly encode: typeof encodeQr;
  readonly decode: typeof decodeQr;
}

/** RGB or RGBA pixels which may contain a QR code. */
export interface QrCodeFrame {
  readonly data: Uint8Array | Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** Binary-safe QR rendering, decoding, and camera access for every app shell. */
@Injectable({ providedIn: 'root' })
export class QrCodeService {
  private codec: QrCodec | null = null;
  private loading: Promise<QrCodec> | null = null;

  /** Whether this runtime can open a camera through the standard media API. */
  get cameraSupported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices?.getUserMedia === 'function'
    );
  }

  /** Load the QR library on first use so it stays out of the initial bundle. */
  load(): Promise<QrCodec> {
    this.loading ??= Promise.all([import('qr'), import('qr/decode.js')]).then(
      ([encoder, decoder]) =>
        (this.codec = { encode: encoder.default, decode: decoder.default }),
      (error: unknown) => {
        this.loading = null;
        throw error;
      },
    );
    return this.loading;
  }

  /** Render arbitrary bytes without converting them through a text encoding. */
  async createDataUrl(data: Uint8ClampedArray): Promise<string> {
    const { encode } = await this.load();
    const gif = encode('trinity-verification', 'gif', {
      border: 4,
      ecc: 'medium',
      encoding: 'byte',
      scale: 8,
      textEncoder: () => Uint8Array.from(data),
    });
    return `data:image/gif;base64,${toBase64(gif)}`;
  }

  /**
   * Decode the raw byte segments in a frame, or `null` when it has no QR code.
   * Frames that arrive before the decoder has loaded are skipped.
   */
  decodeFrame(frame: QrCodeFrame): Uint8ClampedArray | null {
    if (!this.codec) {
      this.load().catch(() => undefined);
      return null;
    }
    const segments: Uint8Array[] = [];
    try {
      this.codec.decode(frame, {
        textDecoder: (bytes: Uint8Array) => {
          segments.push(Uint8Array.from(bytes));
          return '';
        },
      });
    } catch {
      return null;
    }
    if (segments.length === 0) {
      return null;
    }
    const size = segments.reduce((total, segment) => total + segment.length, 0);
    const result = new Uint8ClampedArray(size);
    let offset = 0;
    for (const segment of segments) {
      result.set(segment, offset);
      offset += segment.length;
    }
    return result;
  }

  /** Prompt for the outward-facing camera where available. */
  async openCamera(): Promise<MediaStream> {
    if (!this.cameraSupported) {
      throw new Error('QR scanning isn’t available on this device.');
    }
    this.load().catch(() => undefined); // warm the decoder while the camera starts
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' } },
    });
  }

  /** Release every track owned by a scanner. */
  closeCamera(stream: MediaStream | null): void {
    stream?.getTracks().forEach((track) => track.stop());
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
