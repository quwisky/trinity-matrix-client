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
  collectAccountPasswords,
  hasAccountPassword,
  hasMatrixCredential,
  redactAccountPasswords,
  redactMatrixCredentials,
} from '../e2e/support/matrix-identifiers.mts';
import {
  REGISTRATION_SHARED_SECRET,
  SSO_PASS,
  TEST_PASS,
} from '../e2e/support/synapse/start.mjs';
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

/** The harness's own fixed test-account passwords and registration secret. */
export const HARNESS_SECRETS = Object.freeze([
  TEST_PASS,
  SSO_PASS,
  REGISTRATION_SHARED_SECRET,
]);

/**
 * Bundled code (the report and trace viewers, snapshotted page styles and
 * scripts) is not a diagnostic: a minified library's `password:e` is not a
 * test account's password. It is checked only for known secrets.
 */
const CODE_EXTENSIONS = new Set([
  '.css',
  '.htm',
  '.html',
  '.js',
  '.map',
  '.mjs',
  '.svg',
  '.webmanifest',
]);

const passwordOptions = (name) => ({
  structured: !CODE_EXTENSIONS.has(extname(name).toLowerCase()),
});

/**
 * Redact credentials and passwords, then rescan. `secrets` holds every
 * password harvested from the upload plus the harness's own, so a password
 * is also redacted where no rule recognises its context, as in a
 * `fill("…")` log line.
 */
function scrubText(text, name, secrets) {
  const options = passwordOptions(name);
  const scrubbed = redactAccountPasswords(
    redactMatrixCredentials(text),
    secrets,
    options,
  );
  return hasMatrixCredential(scrubbed) ||
    hasAccountPassword(scrubbed, secrets, options)
    ? undefined
    : scrubbed;
}

/** Call `visit(name, text)` for every text member, descending into archives. */
function visitTexts(name, bytes, visit, depth = 0) {
  if (isZip(bytes)) {
    if (depth >= MAX_ARCHIVE_DEPTH) return;
    let entries;
    try {
      entries = readZip(bytes);
    } catch (error) {
      if (error instanceof ZipFormatError) return;
      throw error;
    }
    for (const entry of entries)
      visitTexts(entry.name, entry.data, visit, depth + 1);
    return;
  }
  if (bytes.includes(0)) return;
  const text = bytes.toString('utf8');
  for (const [, payload] of text.matchAll(HTML_REPORT_PAYLOAD))
    visitTexts('report.zip', Buffer.from(payload, 'base64'), visit, depth + 1);
  visit(name, text);
}

/** Every password the context rules find in the upload, for redaction everywhere. */
export function harvestAccountPasswords(paths) {
  const secrets = new Set(HARNESS_SECRETS);
  for (const path of paths) {
    if (MEDIA_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    visitTexts(path, readFileSync(path), (name, text) => {
      if (!passwordOptions(name).structured) return;
      for (const value of collectAccountPasswords(text)) secrets.add(value);
    });
  }
  return secrets;
}

/**
 * Scrub every text member of an archive, recursing into nested archives.
 * Members that remain unverifiable (unknown binary content or a credential
 * that survives the scrub) are dropped and named in `withheld`.
 */
export function scrubArchive(bytes, secrets = HARNESS_SECRETS, depth = 0) {
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
        nested = scrubArchive(data, secrets, depth + 1);
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
    const scrubbed = scrubText(text, entry.name, secrets);
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

function scrubHtmlReport(text, withheld, secrets) {
  return text.replace(HTML_REPORT_PAYLOAD, (_, open, payload, close) => {
    const archive = scrubArchive(Buffer.from(payload, 'base64'), secrets);
    withheld.push(...archive.withheld.map((name) => `#report!${name}`));
    return archive.changed
      ? `${open}${archive.bytes.toString('base64')}${close}`
      : `${open}${payload}${close}`;
  });
}

/**
 * Redact every Matrix credential and test-account password from one published
 * file in place: text directly, Playwright archives member by member and the
 * HTML report through its embedded payload. `unsafe` means the file cannot be
 * verified and must not be published; `withheld` names archive members that
 * were dropped.
 */
export function scrubReportFile(path, secrets = HARNESS_SECRETS) {
  if (MEDIA_EXTENSIONS.has(extname(path).toLowerCase()))
    return { state: 'media', withheld: [] };
  const bytes = readFileSync(path);
  const withheld = [];
  let output;
  try {
    if (isZip(bytes)) {
      const archive = scrubArchive(bytes, secrets);
      withheld.push(...archive.withheld);
      output = archive.bytes;
    } else if (bytes.includes(0))
      return { state: isKnownBinary(bytes) ? 'media' : 'unsafe', withheld };
    else {
      const text = bytes.toString('utf8');
      const scrubbed = scrubText(
        scrubHtmlReport(text, withheld, secrets),
        path,
        secrets,
      );
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
 * Matrix credential and test-account password from the files an upload would
 * publish (its report globs and `dist/.ci`), including inside blob, HTML and
 * trace archives, and withhold any file or archive member that cannot be
 * verified. Room and event identifiers are kept for debugging.
 */
export function protectReportCredentials({
  root = ROOT,
  reportPath = process.env.CI_REPORT_PATH,
} = {}) {
  const files = new Set();
  for (const pattern of [...patternsFrom(reportPath), 'dist/.ci/**'])
    for (const path of filesUnder(root, pattern)) files.add(path);
  const sorted = [...files].sort();
  const secrets = harvestAccountPasswords(
    sorted.map((path) => join(root, path)),
  );
  const shown = (path) =>
    redactAccountPasswords(redactMatrixCredentials(path), secrets, {
      structured: false,
    });
  const redacted = [];
  const withheld = [];
  for (const path of sorted) {
    const result = scrubReportFile(join(root, path), secrets);
    const name = shown(relative('.', path));
    if (result.state === 'redacted') redacted.push(name);
    withheld.push(
      ...result.withheld.map((member) => shown(`${name}!${member}`)),
    );
    if (result.state === 'unsafe') {
      rmSync(join(root, path), { force: true });
      withheld.push(name);
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
