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
  if (bad) throw new Error(`Unsafe entry in ${ASSET}: ${bad}`);
  const found = names.filter((n) => SCENE.test(n) || n === 'manifest.json');
  for (const name of found) {
    writeFileSync(join(shotsDir, name), await unzip(['-p', zip, name]));
  }
  return scenes.filter((n) => !found.includes(n));
}

export async function prepare({ releases, download, outDir }) {
  const [release] = releases;
  if (!release) throw new Error('No published stable release found.');
  const shotsDir = join(outDir, 'shots');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
  writeFileSync(
    join(outDir, 'release.json'),
    `${JSON.stringify(release, null, 2)}\n`,
  );

  const source = releases.find((r) => r.assets?.some((a) => a.name === ASSET));
  if (!source) return { release, shotsFrom: null, missing: scenes };
  const url = source.assets.find((a) => a.name === ASSET).browser_download_url;
  const tmp = mkdtempSync(join(tmpdir(), 'site-shots-'));
  try {
    const zip = join(tmp, ASSET);
    writeFileSync(zip, await download(url));
    return {
      release,
      shotsFrom: source.tag_name,
      missing: await extract(zip, shotsDir),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
    const res = await fetch(url);
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
