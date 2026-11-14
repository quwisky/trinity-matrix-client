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
import { describe, expect, it } from 'vitest';
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
    'rejects unsafe zip entry %s',
    async (name) => {
      // zip(1) strips these, so build the archive with Python's zipfile-free raw writer.
      const dir = tmp();
      const py = `import zipfile,sys;z=zipfile.ZipFile(sys.argv[1],'w');z.writestr(sys.argv[2],'x')`;
      const zip = join(dir, 'e.zip');
      execFileSync('python3', ['-I', '-c', py, zip, name]);
      const { outDir, download } = setup({ 'v0.7.0': readFileSync(zip) });
      await expect(
        prepare({ releases: [release('v0.7.0', true)], download, outDir }),
      ).rejects.toThrow(/Unsafe entry/);
    },
  );
});
