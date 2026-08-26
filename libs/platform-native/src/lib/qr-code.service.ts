import { Injectable } from '@angular/core';
import encodeQr from 'qr';
import decodeQr from 'qr/decode.js';

/** RGB or RGBA pixels which may contain a QR code. */
export interface QrCodeFrame {
  readonly data: Uint8Array | Uint8ClampedArray | number[];
  readonly width: number;
  readonly height: number;
}

/** Binary-safe QR rendering, decoding, and camera access for every app shell. */
@Injectable({ providedIn: 'root' })
export class QrCodeService {
  /** Whether this runtime can open a camera through the standard media API. */
  get cameraSupported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices?.getUserMedia === 'function'
    );
  }

  /** Render arbitrary bytes without converting them through a text encoding. */
  createDataUrl(data: Uint8ClampedArray): string {
    const gif = encodeQr('trinity-verification', 'gif', {
      border: 4,
      ecc: 'medium',
      encoding: 'byte',
      scale: 8,
      textEncoder: () => Uint8Array.from(data),
    });
    return `data:image/gif;base64,${toBase64(gif)}`;
  }

  /** Decode the raw byte segments in a frame, or `null` when it has no QR code. */
  decodeFrame(frame: QrCodeFrame): Uint8ClampedArray | null {
    const segments: Uint8Array[] = [];
    try {
      decodeQr(frame, {
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
