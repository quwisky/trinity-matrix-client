import { globSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..');

function patternsFrom(reportPath) {
  const patterns = String(reportPath ?? '')
    .split(/\r?\n/u)
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  if (patterns.length === 0) {
    throw new Error('CI_REPORT_PATH must contain at least one report glob');
  }
  return patterns;
}

function isFile(root, path) {
  try {
    return statSync(join(root, path)).isFile();
  } catch {
    return false;
  }
}

function isReportFile(root, path) {
  return (
    isFile(root, path) &&
    /(?:^|\/)(?:index\.html|[^/]+\.(?:zip|xml|png))$/iu.test(path)
  );
}

/** Validate that every configured report glob produced at least one real file. */
export function validateReports({
  root = ROOT,
  reportPath = process.env.CI_REPORT_PATH,
} = {}) {
  const matched = new Set();
  const missing = [];
  for (const pattern of patternsFrom(reportPath)) {
    let files;
    try {
      files = globSync(pattern, { cwd: root, dot: true });
    } catch (error) {
      throw new Error(
        `invalid report glob ${JSON.stringify(pattern)}: ${error.message}`,
        { cause: error },
      );
    }
    const reportFiles = files.filter((path) => isReportFile(root, path));
    if (reportFiles.length === 0) missing.push(pattern);
    for (const path of reportFiles) matched.add(path);
  }
  if (missing.length > 0) {
    throw new Error(`no report files matched: ${missing.join(', ')}`);
  }
  return [...matched].sort();
}

function main() {
  try {
    const files = validateReports();
    for (const file of files) console.log(file);
    console.log(`validated ${files.length} CI report file(s)`);
  } catch (error) {
    console.error(`[ci-diagnostics] ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
