import { describe, expect, it } from 'vitest';
import {
  captureFormat,
  captureModeFor,
  orientToThumbnail,
  parseResolution,
  secondsToMs,
} from './captured-media';

describe('captured media mapping', () => {
  it('derives one capture mode from the plugin and the platform', () => {
    expect(captureModeFor(true, true)).toBe('native');
    expect(captureModeFor(true, false)).toBe('native');
    expect(captureModeFor(false, true)).toBe('web');
    expect(captureModeFor(false, false)).toBe('none');
  });

  it('parses the plugin resolution and rejects anything else', () => {
    expect(parseResolution('1920x1080')).toEqual({ width: 1920, height: 1080 });
    expect(parseResolution(' 1080 × 1920 ')).toEqual({
      width: 1080,
      height: 1920,
    });
    for (const bad of [undefined, '', 'abc', '0x10', '10x0', '1920'])
      expect(parseResolution(bad)).toBeNull();
  });

  it('converts a positive finite duration from seconds to milliseconds', () => {
    expect(secondsToMs(12.5)).toBe(12_500);
    for (const bad of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(secondsToMs(bad)).toBeUndefined();
  });

  it('names a capture from the plugin format, normalising jpg', () => {
    expect(captureFormat('photo', 'jpg', '')).toEqual({
      extension: 'jpeg',
      mimeType: 'image/jpeg',
    });
    expect(captureFormat('photo', 'JPEG', '')).toEqual({
      extension: 'jpeg',
      mimeType: 'image/jpeg',
    });
    expect(captureFormat('video', 'mov', '')).toEqual({
      extension: 'mov',
      mimeType: 'video/quicktime',
    });
    expect(captureFormat('video', 'mp4', '')).toEqual({
      extension: 'mp4',
      mimeType: 'video/mp4',
    });
  });

  it('falls back to the blob type, then to a safe default, when the format is missing or wrong', () => {
    expect(captureFormat('video', undefined, 'video/mp4')).toEqual({
      extension: 'mp4',
      mimeType: 'video/mp4',
    });
    expect(captureFormat('video', 'jpeg', '')).toEqual({
      extension: 'mp4',
      mimeType: 'video/mp4',
    });
    expect(captureFormat('photo', undefined, '')).toEqual({
      extension: 'jpeg',
      mimeType: 'image/jpeg',
    });
  });

  it('turns a sensor-oriented resolution to match the thumbnail it came with', () => {
    expect(
      orientToThumbnail({ width: 4032, height: 3024 }, { w: 120, h: 160 }),
    ).toEqual({ width: 3024, height: 4032 });
    expect(
      orientToThumbnail({ width: 4032, height: 3024 }, { w: 160, h: 120 }),
    ).toEqual({ width: 4032, height: 3024 });
    expect(
      orientToThumbnail({ width: 4032, height: 3024 }, { w: 100, h: 100 }),
    ).toEqual({ width: 4032, height: 3024 });
  });
});
