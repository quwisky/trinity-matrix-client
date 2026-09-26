import { TestBed } from '@angular/core/testing';
import { GifReader } from 'omggif';
import { beforeEach, describe, expect, it } from 'vitest';
import { QrCodeService } from './qr-code.service';

describe('QrCodeService', () => {
  let service: QrCodeService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(QrCodeService);
  });

  it.each([
    'Uint8ClampedArray',
    'Uint8Array',
    'number[]',
    'ImageData prototype dimensions',
  ] as const)(
    'round-trips the exact raw bytes through the production GIF data URL with %s pixels',
    (representation) => {
      const payload = new Uint8ClampedArray([0, 1, 127, 128, 254, 255]);
      const url = service.createDataUrl(payload);
      expect(url).toMatch(/^data:image\/gif;base64,/);

      const bytes = Uint8Array.from(
        atob(url.slice('data:image/gif;base64,'.length)),
        (character) => character.charCodeAt(0),
      );
      const gif = new GifReader(bytes);
      const pixels = new Uint8ClampedArray(gif.width * gif.height * 4);
      gif.decodeAndBlitFrameRGBA(0, pixels);
      const data =
        representation === 'number[]'
          ? Array.from(pixels)
          : representation === 'Uint8Array'
            ? Uint8Array.from(pixels)
            : pixels;
      const originalPixels = Array.from(data);
      // Browser ImageData exposes dimensions through prototype getters, not
      // enumerable own properties. Preserve that supported frame shape too.
      class ImageDataFrame {
        readonly data = data;
        get width(): number {
          return gif.width;
        }
        get height(): number {
          return gif.height;
        }
      }
      const frame =
        representation === 'ImageData prototype dimensions'
          ? new ImageDataFrame()
          : { data, width: gif.width, height: gif.height };

      expect(service.decodeFrame(frame)).toEqual(payload);
      expect(Array.from(data)).toEqual(originalPixels);
    },
  );

  it('returns null when a frame has no QR code', () => {
    expect(
      service.decodeFrame({
        data: new Uint8ClampedArray(16 * 16 * 4).fill(255),
        width: 16,
        height: 16,
      }),
    ).toBeNull();
  });
});
