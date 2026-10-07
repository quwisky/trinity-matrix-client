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

  it('round-trips the exact raw bytes through the production GIF data URL', async () => {
    const payload = new Uint8ClampedArray([0, 1, 127, 128, 254, 255]);
    const pending = service.createDataUrl(payload);
    expect(pending).toBeInstanceOf(Promise);
    const url = await pending;
    expect(url).toMatch(/^data:image\/gif;base64,/);

    const bytes = Uint8Array.from(
      atob(url.slice('data:image/gif;base64,'.length)),
      (character) => character.charCodeAt(0),
    );
    const gif = new GifReader(bytes);
    const pixels = new Uint8ClampedArray(gif.width * gif.height * 4);
    gif.decodeAndBlitFrameRGBA(0, pixels);
    const frame = { data: pixels, width: gif.width, height: gif.height };

    expect(service.decodeFrame(frame)).toEqual(payload);
  });

  it('skips frames that arrive before the decoder has loaded', async () => {
    const payload = new Uint8ClampedArray([7, 8, 9]);
    const url = await new QrCodeService().createDataUrl(payload);
    const gif = new GifReader(
      Uint8Array.from(atob(url.slice('data:image/gif;base64,'.length)), (c) =>
        c.charCodeAt(0),
      ),
    );
    const pixels = new Uint8ClampedArray(gif.width * gif.height * 4);
    gif.decodeAndBlitFrameRGBA(0, pixels);
    const frame = { data: pixels, width: gif.width, height: gif.height };
    const cold = new QrCodeService();

    expect(cold.decodeFrame(frame)).toBeNull();
    await cold.load();
    expect(cold.decodeFrame(frame)).toEqual(payload);
  });

  it('returns null when a frame has no QR code', async () => {
    await service.load();
    expect(
      service.decodeFrame({
        data: new Uint8ClampedArray(16 * 16 * 4).fill(255),
        width: 16,
        height: 16,
      }),
    ).toBeNull();
  });
});
