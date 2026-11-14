import { describe, expect, it } from 'vitest';
import fallback from '../data/release.fallback.json' with { type: 'json' };
import { resolveDownloads } from './downloads.mjs';

const page =
  'https://github.com/quwisky/trinity-matrix-client/releases/tag/v0.7.0';
const url = (name) =>
  `https://github.com/quwisky/trinity-matrix-client/releases/download/v0.7.0/${name}`;
const asset = (name) => ({ name, browser_download_url: url(name) });
const published = [
  'Trinity-0.7.0-arm64.dmg',
  'Trinity-0.7.0-arm64-mac.zip',
  'Trinity.Setup.0.7.0.exe',
  'Trinity-0.7.0.AppImage',
  'trinity-desktop_0.7.0_amd64.deb',
  'Trinity-Web-0.7.0.zip',
];
const release = (names) => ({
  tag_name: 'v0.7.0',
  html_url: page,
  assets: names.map(asset),
});

describe('resolveDownloads', () => {
  it('maps each published asset to its platform', () => {
    expect(resolveDownloads(release(published))).toEqual({
      macDmg: url('Trinity-0.7.0-arm64.dmg'),
      macZip: url('Trinity-0.7.0-arm64-mac.zip'),
      windows: url('Trinity.Setup.0.7.0.exe'),
      linuxAppImage: url('Trinity-0.7.0.AppImage'),
      linuxDeb: url('trinity-desktop_0.7.0_amd64.deb'),
      web: url('Trinity-Web-0.7.0.zip'),
      version: '0.7.0',
    });
  });

  it('falls back to the release page for a missing asset', () => {
    const all = resolveDownloads(release(published));
    const withoutDeb = resolveDownloads(
      release(published.filter((name) => !name.endsWith('.deb'))),
    );
    expect(withoutDeb).toEqual({ ...all, linuxDeb: page });
  });

  it('ignores look-alike assets', () => {
    const downloads = resolveDownloads(
      release([
        'site-screenshots.zip',
        'latest-mac.yml',
        'latest.yml',
        'Trinity-0.7.0-arm64.dmg.blockmap',
        'Trinity.Setup.0.7.0.exe.blockmap',
        'Trinity-0.7.0-arm64-mac.zip.blockmap',
      ]),
    );
    expect(downloads).toEqual({
      macDmg: page,
      macZip: page,
      windows: page,
      linuxAppImage: page,
      linuxDeb: page,
      web: page,
      version: '0.7.0',
    });
  });

  it('works with the offline fallback', () => {
    const latest =
      'https://github.com/quwisky/trinity-matrix-client/releases/latest';
    const { version, ...links } = resolveDownloads(fallback);
    expect(version).toBeNull();
    expect(Object.values(links)).toHaveLength(6);
    for (const link of Object.values(links)) expect(link).toBe(latest);
  });
});
