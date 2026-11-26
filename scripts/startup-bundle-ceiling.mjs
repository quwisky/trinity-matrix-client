/** Fails the renderer build when the startup JavaScript closure outgrows its recorded ceiling. */
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

// Measured 2026-11-25 on the MatrixRTC calls branch: 2,410,421 bytes in 26 files, rounded
// up to the next 10 kB. The call service and room call frame are wired into the rooms page
// eagerly. Lower it when a reduction lands; raise it only in the pull request that grows the
// closure, with the reason.
export const CEILING_BYTES = 2_420_000;

const SCRIPT_TAG = /<script\b[^>]*\bsrc=["']([^"']+\.js)["']/g;
// Static imports and re-exports only: `import("./x.js")` has a paren, so it never matches.
const STATIC_IMPORT = /(?:\bfrom|\bimport)\s*["']\.\/([^"']+\.js)["']/g;

function read(root, file) {
  try {
    return readFileSync(join(root, file), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Startup closure: ${file} is missing from ${root}`, {
        cause: error,
      });
    }
    throw error;
  }
}

export function startupClosure(root) {
  const html = read(root, 'index.html');
  const pending = [...html.matchAll(SCRIPT_TAG)].map((match) =>
    posix.normalize(match[1]),
  );
  if (pending.length === 0) {
    throw new Error(`Startup closure: index.html in ${root} names no script`);
  }
  const files = new Map();
  while (pending.length > 0) {
    const file = pending.pop();
    if (files.has(file)) continue;
    const source = read(root, file);
    files.set(file, Buffer.byteLength(source));
    for (const match of source.matchAll(STATIC_IMPORT)) pending.push(match[1]);
  }
  const totalBytes = [...files.values()].reduce((sum, size) => sum + size, 0);
  return { files: [...files.keys()].sort(), totalBytes };
}

export function checkStartupBundle(root, ceiling = CEILING_BYTES) {
  const { files, totalBytes } = startupClosure(root);
  const summary = `Startup closure: ${totalBytes} bytes in ${files.length} files (ceiling ${ceiling}).`;
  if (totalBytes > ceiling) {
    throw new Error(
      `${summary}\nIt is ${totalBytes - ceiling} bytes over the ceiling. Defer the new code behind a dynamic import, or raise CEILING_BYTES in scripts/startup-bundle-ceiling.mjs in this pull request and state the reason.`,
    );
  }
  return summary;
}

if (import.meta.main) {
  try {
    console.log(checkStartupBundle(process.argv[2] ?? 'www'));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
