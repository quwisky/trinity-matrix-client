import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { prepare } from './prepare.mjs';

const scene = (n) => `${n}-${n === 'chat' ? 'phone' : 'desktop'}-dark.png`;
const tmp = () => mkdtempSync(join(tmpdir(), 'prepare-spec-'));

const zipOf = (files) => {
  const dir = tmp();
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  const zip = join(tmp(), 'a.zip');
  execFileSync('zip', ['-q', '-r', '-X', zip, '.'], { cwd: dir });
  return readFileSync(zip);
};

const release = (tag, withZip) => ({
  tag_name: tag,
  html_url: `https://example.test/${tag}`,
  assets: withZip
    ? [
        {
          name: 'site-screenshots.zip',
          browser_download_url: `https://x/${tag}.zip`,
        },
      ]
    : [],
});

const setup = (zips) => ({
  outDir: join(tmp(), '.generated'),
  download: async (url) => zips[url.split('/').pop().replace('.zip', '')],
});

describe('prepare', () => {
  it('uses the latest stable release for downloads', async () => {
    const releases = [release('v0.8.0', false), release('v0.7.0', false)];
    const { outDir, download } = setup({});
    const out = await prepare({ releases, download, outDir });
    expect(out.release).toEqual(releases[0]);
    expect(
      JSON.parse(readFileSync(join(outDir, 'release.json'), 'utf8')),
    ).toEqual(releases[0]);
  });

  it('takes screenshots from the newest release that has them', async () => {
    const { outDir, download } = setup({
      'v0.7.0': zipOf({ [scene('hero')]: 'x' }),
    });
    const out = await prepare({
      releases: [release('v0.8.0', false), release('v0.7.0', true)],
      download,
      outDir,
    });
    expect(out.shotsFrom).toBe('v0.7.0');
    expect(readdirSync(join(outDir, 'shots'))).toContain(scene('hero'));
  });

  it('builds with placeholders when no release has screenshots', async () => {
    const { outDir, download } = setup({});
    const out = await prepare({
      releases: [release('v0.7.0', false)],
      download,
      outDir,
    });
    expect(out.shotsFrom).toBeNull();
    expect(readdirSync(join(outDir, 'shots'))).toEqual([]);
  });

  it('reports missing scenes and ignores extra files', async () => {
    const all = ['hero', 'accounts', 'encryption', 'chat'].flatMap((s) =>
      ['desktop', 'phone'].flatMap((v) =>
        ['dark', 'light'].map((t) => `${s}-${v}-${t}.png`),
      ),
    );
    const files = Object.fromEntries(
      all.filter((n) => n !== 'chat-phone-light.png').map((n) => [n, 'x']),
    );
    const { outDir, download } = setup({
      'v0.7.0': zipOf({ ...files, 'notes.txt': 'n', 'manifest.json': '{}' }),
    });
    const out = await prepare({
      releases: [release('v0.7.0', true)],
      download,
      outDir,
    });
    expect(out.missing).toEqual(['chat-phone-light.png']);
    expect(existsSync(join(outDir, 'shots/notes.txt'))).toBe(false);
    expect(existsSync(join(outDir, 'shots/manifest.json'))).toBe(true);
  });

  it.each(['../evil.png', '/abs/evil.png'])(
    'builds with placeholders on unsafe zip entry %s',
    async (name) => {
      // zip(1) strips these, so write the archive with Python's zipfile.
      const zip = join(tmp(), 'e.zip');
      const py = `import zipfile,sys;z=zipfile.ZipFile(sys.argv[1],'w');z.writestr(sys.argv[2],'x');z.writestr(sys.argv[3],'y')`;
      execFileSync('python3', ['-I', '-c', py, zip, name, scene('hero')]);
      const { outDir, download } = setup({ 'v0.7.0': readFileSync(zip) });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const out = await prepare({
        releases: [release('v0.7.0', true)],
        download,
        outDir,
      });
      expect(out.shotsFrom).toBeNull();
      expect(readdirSync(join(outDir, 'shots'))).toEqual([]);
      expect(error.mock.calls.join()).toContain(name);
      error.mockRestore();
    },
  );

  it('builds with placeholders when the download fails', async () => {
    const outDir = join(tmp(), '.generated');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const download = async () => {
      throw new Error('HTTP 503');
    };
    const out = await prepare({
      releases: [release('v0.7.0', true)],
      download,
      outDir,
    });
    expect(out.shotsFrom).toBeNull();
    expect(existsSync(join(outDir, 'release.json'))).toBe(true);
    expect(readdirSync(join(outDir, 'shots'))).toEqual([]);
    warn.mockRestore();
  });

  it('builds with placeholders when the zip is corrupt', async () => {
    const { outDir, download } = setup({ 'v0.7.0': Buffer.from('not a zip') });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await prepare({
      releases: [release('v0.7.0', true)],
      download,
      outDir,
    });
    expect(out.shotsFrom).toBeNull();
    expect(readdirSync(join(outDir, 'shots'))).toEqual([]);
    warn.mockRestore();
  });

  it('writes no release.json for an empty list', async () => {
    const { outDir, download } = setup({});
    const out = await prepare({ releases: [], download, outDir });
    expect(out.release).toBeNull();
    expect(out.shotsFrom).toBeNull();
    expect(existsSync(join(outDir, 'release.json'))).toBe(false);
  });

  it('chooses the highest version, not the newest created', async () => {
    const { outDir, download } = setup({});
    const releases = [
      release('v0.7.1', false),
      release('v0.8.0', false),
      release('v0.7.9', false),
    ];
    const out = await prepare({ releases, download, outDir });
    expect(out.release.tag_name).toBe('v0.8.0');
  });
});
