import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packWebRelease, webZipName } from './web-release-zip.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture({ manifest = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'trinity-web-zip-'));
  roots.push(root);
  mkdirSync(join(root, 'www/assets'), { recursive: true });
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'www/index.html'), '<!doctype html>\n');
  writeFileSync(join(root, 'www/assets/app.js'), 'app\n');
  writeFileSync(join(root, 'LICENSE'), 'MIT License\n');
  if (manifest)
    writeFileSync(join(root, 'dist/web-bundle-manifest.json'), '{}\n');
  return root;
}

describe('web release zip', () => {
  it('names the zip after the full release version', () => {
    expect(webZipName('0.2.0')).toBe('Trinity-Web-0.2.0.zip');
    expect(webZipName('0.2.0-next.3')).toBe('Trinity-Web-0.2.0-next.3.zip');
    expect(() => webZipName('v0.2.0')).toThrow(/version/);
    expect(() => webZipName('0.2')).toThrow(/version/);
  });

  it('packs www, LICENSE and the manifest under one trinity-web folder', () => {
    const root = fixture();
    const zip = packWebRelease({
      root,
      version: '1.4.0',
      outDir: join(root, 'release'),
    });
    expect(basename(zip)).toBe('Trinity-Web-1.4.0.zip');
    const entries = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter((entry) => !entry.endsWith('/'))
      .sort();
    expect(entries).toEqual([
      'trinity-web/LICENSE',
      'trinity-web/web-bundle-manifest.json',
      'trinity-web/www/assets/app.js',
      'trinity-web/www/index.html',
    ]);
  });

  it('refuses to pack without the verified manifest', () => {
    const root = fixture({ manifest: false });
    expect(() =>
      packWebRelease({ root, version: '1.4.0', outDir: join(root, 'release') }),
    ).toThrow(/web-bundle-manifest\.json/);
  });
});
