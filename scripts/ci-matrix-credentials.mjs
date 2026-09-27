import {
  appendFileSync,
  globSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { extname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  hasMatrixCredential,
  redactMatrixCredentials,
} from '../e2e/support/matrix-identifiers.mts';
import { ZipFormatError, isZip, readZip, writeZip } from './zip-archive.mjs';

const ROOT = join(import.meta.dirname, '..');

/** Raster and video proof carries no text diagnostic; it is left untouched. */
const MEDIA_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.mp4',
  '.png',
  '.tif',
  '.tiff',
  '.webm',
  '.webp',
]);

/**
 * Binary archive members that carry no text diagnostic, recognised by their
 * content rather than their name: trace screencast frames and screenshots,
 * the application's WebAssembly and fonts the report viewer needs.
 */
const BINARY_SIGNATURES = [
  [0, [0x89, 0x50, 0x4e, 0x47]], // PNG
  [0, [0xff, 0xd8, 0xff]], // JPEG
  [0, [0x47, 0x49, 0x46, 0x38]], // GIF
  [8, [0x57, 0x45, 0x42, 0x50]], // WebP (RIFF container)
  [0, [0x1a, 0x45, 0xdf, 0xa3]], // WebM
  [4, [0x66, 0x74, 0x79, 0x70]], // MP4 and AVIF (ftyp box)
  [0, [0x00, 0x61, 0x73, 0x6d]], // WebAssembly
  [0, [0x77, 0x4f, 0x46, 0x46]], // WOFF
  [0, [0x77, 0x4f, 0x46, 0x32]], // WOFF2
  [0, [0x00, 0x01, 0x00, 0x00]], // TrueType
  [0, [0x4f, 0x54, 0x54, 0x4f]], // OpenType
];

const isKnownBinary = (bytes) =>
  BINARY_SIGNATURES.some(([offset, signature]) =>
    signature.every((byte, index) => bytes[offset + index] === byte),
  );

/** The HTML reporter embeds its report data as one base64 ZIP payload. */
const HTML_REPORT_PAYLOAD =
  /(<template id="playwrightReportBase64">data:application\/zip;base64,)([A-Za-z0-9+/=]*)(<\/template>)/gu;

/** Nested archives: a blob report holds traces, which hold their resources. */
const MAX_ARCHIVE_DEPTH = 4;

function scrubText(text) {
  const scrubbed = redactMatrixCredentials(text);
  return hasMatrixCredential(scrubbed) ? undefined : scrubbed;
}

/**
 * Scrub every text member of an archive, recursing into nested archives.
 * Members that remain unverifiable (unknown binary content or a credential
 * that survives the scrub) are dropped and named in `withheld`.
 */
export function scrubArchive(bytes, depth = 0) {
  if (depth >= MAX_ARCHIVE_DEPTH)
    throw new ZipFormatError('archives are nested too deeply');
  const entries = readZip(bytes);
  const kept = [];
  const withheld = [];
  let changed = false;
  for (const entry of entries) {
    const { data } = entry;
    if (entry.name.endsWith('/') && data.length === 0) {
      kept.push(entry);
      continue;
    }
    if (isZip(data)) {
      let nested;
      try {
        nested = scrubArchive(data, depth + 1);
      } catch (error) {
        if (!(error instanceof ZipFormatError)) throw error;
        nested = undefined;
      }
      if (!nested) {
        withheld.push(entry.name);
        changed = true;
        continue;
      }
      withheld.push(...nested.withheld.map((name) => `${entry.name}!${name}`));
      if (nested.changed) {
        kept.push({ ...entry, data: nested.bytes, stored: undefined });
        changed = true;
      } else kept.push(entry);
      continue;
    }
    if (data.includes(0)) {
      if (isKnownBinary(data)) kept.push(entry);
      else {
        withheld.push(entry.name);
        changed = true;
      }
      continue;
    }
    const text = data.toString('utf8');
    const scrubbed = scrubText(text);
    if (scrubbed === undefined) {
      withheld.push(entry.name);
      changed = true;
    } else if (scrubbed !== text) {
      kept.push({
        ...entry,
        data: Buffer.from(scrubbed, 'utf8'),
        stored: undefined,
      });
      changed = true;
    } else kept.push(entry);
  }
  return { bytes: changed ? writeZip(kept) : bytes, changed, withheld };
}

function scrubHtmlReport(text, withheld) {
  return text.replace(HTML_REPORT_PAYLOAD, (_, open, payload, close) => {
    const archive = scrubArchive(Buffer.from(payload, 'base64'));
    withheld.push(...archive.withheld.map((name) => `#report!${name}`));
    return archive.changed
      ? `${open}${archive.bytes.toString('base64')}${close}`
      : `${open}${payload}${close}`;
  });
}

/**
 * Redact every Matrix credential from one published file in place: text
 * directly, Playwright archives member by member and the HTML report through
 * its embedded payload. `unsafe` means the file cannot be verified and must
 * not be published; `withheld` names archive members that were dropped.
 */
export function scrubReportFile(path) {
  if (MEDIA_EXTENSIONS.has(extname(path).toLowerCase()))
    return { state: 'media', withheld: [] };
  const bytes = readFileSync(path);
  const withheld = [];
  let output;
  try {
    if (isZip(bytes)) {
      const archive = scrubArchive(bytes);
      withheld.push(...archive.withheld);
      output = archive.bytes;
    } else if (bytes.includes(0))
      return { state: isKnownBinary(bytes) ? 'media' : 'unsafe', withheld };
    else {
      const text = bytes.toString('utf8');
      const scrubbed = scrubText(scrubHtmlReport(text, withheld));
      if (scrubbed === undefined) return { state: 'unsafe', withheld };
      output = scrubbed === text ? bytes : Buffer.from(scrubbed, 'utf8');
    }
  } catch (error) {
    if (error instanceof ZipFormatError) return { state: 'unsafe', withheld };
    throw error;
  }
  if (output === bytes) return { state: 'clean', withheld };
  writeFileSync(path, output);
  return { state: 'redacted', withheld };
}

function patternsFrom(reportPath) {
  const patterns = String(reportPath ?? '')
    .split(/\r?\n/u)
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  if (patterns.length === 0)
    throw new Error('CI_REPORT_PATH must contain at least one report glob');
  return patterns;
}

function filesUnder(root, pattern) {
  return globSync(pattern, { cwd: root, dot: true }).filter((path) => {
    try {
      return statSync(join(root, path)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * The browser, desktop and component publication boundary: redact every
 * Matrix credential from the files an upload would publish (its report globs
 * and `dist/.ci`), including inside blob, HTML and trace archives, and
 * withhold any file or archive member that cannot be verified.
 */
export function protectReportCredentials({
  root = ROOT,
  reportPath = process.env.CI_REPORT_PATH,
} = {}) {
  const files = new Set();
  for (const pattern of [...patternsFrom(reportPath), 'dist/.ci/**'])
    for (const path of filesUnder(root, pattern)) files.add(path);
  const redacted = [];
  const withheld = [];
  for (const path of [...files].sort()) {
    const result = scrubReportFile(join(root, path));
    const shown = redactMatrixCredentials(relative('.', path));
    if (result.state === 'redacted') redacted.push(shown);
    withheld.push(
      ...result.withheld.map((name) =>
        redactMatrixCredentials(`${shown}!${name}`),
      ),
    );
    if (result.state === 'unsafe') {
      rmSync(join(root, path), { force: true });
      withheld.push(shown);
    }
  }
  return { files: files.size, redacted, withheld };
}

function main() {
  try {
    const { files, redacted, withheld } = protectReportCredentials();
    console.log(
      `[ci-matrix-credentials] verified ${files} file(s); redacted ${redacted.length}; withheld ${withheld.length}`,
    );
    for (const path of withheld)
      console.error(`[ci-matrix-credentials] withheld ${path}`);
    // Every remaining file was verified, so the upload may proceed even
    // when something had to be withheld; the step still fails the job.
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, 'verified=true\n');
    if (withheld.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(
      `[ci-matrix-credentials] diagnostics were not verified: ${error instanceof Error ? error.name : typeof error}`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
