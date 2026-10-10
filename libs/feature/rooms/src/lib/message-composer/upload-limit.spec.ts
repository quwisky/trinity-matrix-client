import { describe, expect, it } from 'vitest';
import {
  effectiveUploadLimit,
  fallbackUploadBytes,
  tooLargeMessage,
} from './upload-limit';

const MB = 1_048_576;

describe('fallbackUploadBytes', () => {
  it('caps a native mobile host at 256 MB', () => {
    expect(fallbackUploadBytes(true)).toBe(256 * MB);
  });

  it('caps web and desktop at 512 MB', () => {
    expect(fallbackUploadBytes(false)).toBe(512 * MB);
  });
});

describe('effectiveUploadLimit', () => {
  it('falls back to the device cap when the homeserver states no limit', () => {
    expect(effectiveUploadLimit(null, true)).toEqual({
      source: 'device',
      bytes: 256 * MB,
    });
    expect(effectiveUploadLimit(null, false)).toEqual({
      source: 'device',
      bytes: 512 * MB,
    });
  });

  it('keeps a homeserver limit below the device cap', () => {
    expect(effectiveUploadLimit(50 * MB, true)).toEqual({
      source: 'homeserver',
      bytes: 50 * MB,
    });
  });

  it('keeps a homeserver limit above the device cap: a stated limit always wins', () => {
    expect(effectiveUploadLimit(2048 * MB, true)).toEqual({
      source: 'homeserver',
      bytes: 2048 * MB,
    });
  });
});

describe('tooLargeMessage', () => {
  it("names the homeserver's limit when the homeserver set it", () => {
    expect(
      tooLargeMessage('video', { source: 'homeserver', bytes: 100 * MB }),
    ).toBe(
      'That video is too large to send. Your homeserver accepts files up to 100 MB.',
    );
  });

  it("names this device's cap, not the homeserver, when the fallback applied", () => {
    expect(
      tooLargeMessage('photo', { source: 'device', bytes: 256 * MB }),
    ).toBe(
      'That photo is too large to send. Trinity can send files up to 256 MB on this device.',
    );
  });

  it('counts several refused files in one sentence', () => {
    expect(
      tooLargeMessage('file', { source: 'device', bytes: 512 * MB }, 3),
    ).toBe(
      '3 files are too large to send. Trinity can send files up to 512 MB on this device.',
    );
  });

  it('never rounds a limit down to 0 MB', () => {
    expect(tooLargeMessage('file', { source: 'homeserver', bytes: 1000 })).toBe(
      'That file is too large to send. Your homeserver accepts files up to 1 MB.',
    );
  });
});
