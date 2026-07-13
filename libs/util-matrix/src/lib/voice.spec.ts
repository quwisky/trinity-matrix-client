import { describe, expect, it } from 'vitest';
import { downsampleWaveform, voiceMessageContent } from './voice';

describe('downsampleWaveform', () => {
  it('reduces samples to the requested number of buckets', () => {
    const samples = new Float32Array(1000).fill(0.5);
    expect(downsampleWaveform(samples, 40)).toHaveLength(40);
  });

  it('takes the peak of each bucket and normalizes to the loudest (0..1024)', () => {
    // Two buckets: first peaks at 0.25, second at 0.5 → normalized to 512 and 1024.
    const samples = [0.1, 0.25, 0.5, 0.2];
    expect(downsampleWaveform(samples, 2)).toEqual([512, 1024]);
  });

  it('uses absolute amplitude (negative troughs count)', () => {
    expect(downsampleWaveform([-1, 0, 0.5, -0.5], 2)).toEqual([1024, 512]);
  });

  it('returns all-zero for silence and empty for no samples', () => {
    expect(downsampleWaveform([0, 0, 0, 0], 2)).toEqual([0, 0]);
    expect(downsampleWaveform([], 4)).toEqual([]);
    expect(downsampleWaveform([1, 2, 3], 0)).toEqual([]);
  });
});

describe('voiceMessageContent', () => {
  it('builds an m.audio with the MSC3245 voice marker and MSC1767 waveform', () => {
    const content = voiceMessageContent(
      { mxc: 'mxc://hs/clip', file: null, mimeType: 'audio/webm', size: 2048 },
      4200,
      [0, 512, 1024],
    ) as Record<string, unknown>;

    expect(content['msgtype']).toBe('m.audio');
    expect(content['body']).toBe('Voice message');
    expect(content['url']).toBe('mxc://hs/clip');
    expect(content['info']).toEqual({
      mimetype: 'audio/webm',
      size: 2048,
      duration: 4200,
    });
    expect(content['org.matrix.msc3245.voice']).toEqual({});
    expect(content['org.matrix.msc1767.audio']).toEqual({
      duration: 4200,
      waveform: [0, 512, 1024],
    });
  });

  it('carries an encrypted file instead of a url when the room is E2EE', () => {
    const file = { url: 'mxc://hs/enc' } as never;
    const content = voiceMessageContent(
      { mxc: null, file, mimeType: 'audio/webm', size: 10 },
      1000,
      [1],
    ) as Record<string, unknown>;

    expect(content['file']).toBe(file);
    expect(content['url']).toBeUndefined();
  });
});
