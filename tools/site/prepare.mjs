import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ASSET = 'site-screenshots.zip';
const SCENE =
  /^(hero|accounts|encryption|chat)-(desktop|phone)-(dark|light)\.png$/;
const scenes = ['hero', 'accounts', 'encryption', 'chat'].flatMap((s) =>
  ['desktop', 'phone'].flatMap((v) =>
    ['dark', 'light'].map((t) => `${s}-${v}-${t}.png`),
  ),
);

// Zip entries are untrusted: only the known names are ever read, and a path that could
// escape the output directory fails the build instead of being skipped.
const isUnsafe = (name) =>
  name.startsWith('/') ||
  /^[A-Za-z]:/.test(name) ||
  name.includes('\\') ||
  name.split('/').includes('..');

class UnsafeEntry extends Error {}

const unzip = async (args) =>
  (
    await run('unzip', args, {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    })
  ).stdout;

async function extract(zip, shotsDir) {
  const names = (await unzip(['-Z1', zip]))
    .toString('utf8')
    .split('\n')
    .filter(Boolean);
  const bad = names.find(isUnsafe);
  if (bad) throw new UnsafeEntry(`Unsafe entry in ${ASSET}: ${bad}`);
  const found = names.filter((n) => SCENE.test(n) || n === 'manifest.json');
  for (const name of found) {
    writeFileSync(join(shotsDir, name), await unzip(['-p', zip, name]));
  }
  return scenes.filter((n) => !found.includes(n));
}

const semver = (tag) =>
  (/^v(\d+)\.(\d+)\.(\d+)$/.exec(tag) ?? []).slice(1).map(Number);
const byVersionDesc = (a, b) => {
  const [x, y] = [semver(a.tag_name), semver(b.tag_name)];
  return [0, 1, 2].map((i) => (y[i] ?? -1) - (x[i] ?? -1)).find(Boolean) ?? 0;
};

export async function prepare({ releases, download, outDir }) {
  const sorted = releases
    .filter((r) => semver(r.tag_name).length)
    .sort(byVersionDesc);
  const shotsDir = join(outDir, 'shots');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
  const [release = null] = sorted;
  if (!release) return { release, shotsFrom: null, missing: scenes };
  writeFileSync(
    join(outDir, 'release.json'),
    `${JSON.stringify(release, null, 2)}\n`,
  );

  const source = sorted.find((r) => r.assets?.some((a) => a.name === ASSET));
  if (!source) return { release, shotsFrom: null, missing: scenes };
  const none = { release, shotsFrom: null, missing: scenes };
  const tmp = mkdtempSync(join(tmpdir(), 'site-shots-'));
  try {
    const url = source.assets.find(
      (a) => a.name === ASSET,
    ).browser_download_url;
    const zip = join(tmp, ASSET);
    writeFileSync(zip, await download(url));
    return {
      release,
      shotsFrom: source.tag_name,
      missing: await extract(zip, shotsDir),
    };
  } catch (error) {
    // A screenshot problem must never block the deploy: build with placeholders.
    rmSync(shotsDir, { recursive: true, force: true });
    mkdirSync(shotsDir, { recursive: true });
    if (error instanceof UnsafeEntry)
      console.error(`::error::${error.message}`);
    else console.warn(`::warning::Screenshots skipped: ${error.message}`);
    return none;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // A failing releases lookup stops the deploy on purpose, like the user-guide lookup in
  // docs-pages.yml: stale download links are worse than no deploy.
  const { stdout } = await run(
    'gh',
    ['api', 'repos/{owner}/{repo}/releases', '--paginate', '--slurp'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const releases = JSON.parse(stdout)
    .flat()
    .filter((r) => !r.draft && !r.prerelease);
  const outDir = join(import.meta.dirname, '../../apps/site/.generated');
  const download = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
    return Buffer.from(await res.arrayBuffer());
  };
  const { release, shotsFrom, missing } = await prepare({
    releases,
    download,
    outDir,
  });
  console.log(
    `Downloads from ${release.tag_name}; screenshots from ${shotsFrom ?? 'placeholders'}.`,
  );
  if (shotsFrom && missing.length)
    console.log(`Missing scenes: ${missing.join(', ')}`);
}
