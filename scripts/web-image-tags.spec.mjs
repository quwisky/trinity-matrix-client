import { describe, expect, it } from 'vitest';
import { imageTags } from './web-image-tags.mjs';

describe('web image tags', () => {
  it('gives a newest stable release its version, minor and latest tags', () => {
    expect(imageTags('v1.4.2', ['v1.4.2', 'v1.4.1', 'v1.5.0-next.1'])).toEqual([
      '1.4.2',
      '1.4',
      'latest',
    ]);
  });

  it('gives a newest prerelease its version and next tags', () => {
    expect(
      imageTags('v1.5.0-next.2', ['v1.5.0-next.2', 'v1.5.0-next.1', 'v1.4.2']),
    ).toEqual(['1.5.0-next.2', 'next']);
  });

  it('never moves a moving tag back for an older release', () => {
    expect(imageTags('v1.4.1', ['v1.4.2', 'v1.4.1'])).toEqual(['1.4.1']);
    expect(
      imageTags('v1.5.0-next.1', ['v1.5.0-next.2', 'v1.5.0-next.1']),
    ).toEqual(['1.5.0-next.1']);
    // 1.4.x stays the newest 1.4 line even after 1.5.0 exists.
    expect(imageTags('v1.4.3', ['v1.5.0', 'v1.4.3', 'v1.4.2'])).toEqual([
      '1.4.3',
      '1.4',
    ]);
  });

  it('keeps the stable and next lines independent', () => {
    expect(imageTags('v2.0.0-next.1', ['v2.0.0-next.1', 'v3.0.0'])).toEqual([
      '2.0.0-next.1',
      'next',
    ]);
    expect(imageTags('v1.0.0', ['v1.0.0', 'v9.0.0-next.1'])).toEqual([
      '1.0.0',
      '1.0',
      'latest',
    ]);
  });

  it('rejects tags that are not release versions', () => {
    expect(() => imageTags('1.4.2', [])).toThrow(/release tag/);
    expect(() => imageTags('v1.4.2-beta.1', [])).toThrow(/release tag/);
  });

  it('ignores unparseable published tags', () => {
    expect(imageTags('v1.0.0', ['v1.0.0', 'nightly', 'v1.0'])).toEqual([
      '1.0.0',
      '1.0',
      'latest',
    ]);
  });
});
