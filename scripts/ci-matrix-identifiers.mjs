import { appendFileSync, globSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  redactMatrixIdentifiers,
  scrubMatrixIdentifierFile,
} from '../e2e/support/matrix-identifiers.mts';

const ROOT = join(import.meta.dirname, '..');

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
 * The Android publication boundary: redact every Matrix Room and event
 * identifier shape from the files an upload would publish (its report globs
 * and `dist/.ci`), withhold any file that still carries one or is not text,
 * and report whether every file was verified.
 */
export async function protectUploadDiagnostics({
  root = ROOT,
  reportPath = process.env.CI_REPORT_PATH,
} = {}) {
  const files = new Set();
  for (const pattern of [...patternsFrom(reportPath), 'dist/.ci/**'])
    for (const path of filesUnder(root, pattern)) files.add(path);
  const redacted = [];
  const withheld = [];
  for (const path of [...files].sort()) {
    const state = await scrubMatrixIdentifierFile(join(root, path));
    if (state === 'redacted') redacted.push(path);
    if (state === 'unsafe') {
      rmSync(join(root, path), { force: true });
      withheld.push(redactMatrixIdentifiers(relative('.', path)));
    }
  }
  return { files: files.size, redacted, withheld };
}

async function main() {
  try {
    const { files, redacted, withheld } = await protectUploadDiagnostics();
    console.log(
      `[ci-matrix-identifiers] verified ${files} file(s); redacted ${redacted.length}; withheld ${withheld.length}`,
    );
    for (const path of withheld)
      console.error(`[ci-matrix-identifiers] withheld ${path}`);
    // Every remaining file was verified, so the upload may proceed even
    // when a file had to be withheld; the step still fails the job.
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, 'verified=true\n');
    if (withheld.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(
      `[ci-matrix-identifiers] diagnostics were not verified: ${error instanceof Error ? error.name : typeof error}`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
