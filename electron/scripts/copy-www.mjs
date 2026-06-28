// Copies the Angular web build (repo-root www/) into electron/www so it can be
// packaged into the app bundle.
//
// Zero dependencies. Uses a manual recursive walk with copyFileSync rather than
// fs.cpSync: cpSync's reflink/copy_file_range fast path can fail with EACCES on
// some overlay/bind-mounted filesystems, whereas copyFileSync is portable
// (Linux/macOS/Windows) and avoids that path.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const electronRoot = dirname(here); // electron/
const repoRoot = dirname(electronRoot); // repo root
const src = join(repoRoot, 'www');
const dest = join(electronRoot, 'www');

if (!existsSync(src)) {
  console.error(
    `[copy-www] Web build not found at ${src}\n` +
      `[copy-www] Run "pnpm build" (nx build trinity) first.`,
  );
  process.exit(1);
}

/** Recursively copy a directory tree using copyFileSync. */
function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const fromPath = join(from, entry.name);
    const toPath = join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(fromPath, toPath);
    } else if (entry.isFile()) {
      copyFileSync(fromPath, toPath);
    }
    // (build output has no symlinks/special files; skip anything else)
  }
}

rmSync(dest, { recursive: true, force: true });
copyDir(src, dest);

const fileCount = (function count(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? count(join(dir, e.name)) : 1;
  }
  return n;
})(dest);

const wasm = join(dest, 'assets', 'crypto', 'matrix_sdk_crypto_wasm_bg.wasm');
if (!existsSync(wasm)) {
  console.warn(`[copy-www] WARNING: crypto WASM missing in copy: ${wasm}`);
} else {
  console.log(`[copy-www] crypto WASM ok (${statSync(wasm).size} bytes)`);
}
console.log(`[copy-www] Copied ${fileCount} files: ${src} -> ${dest}`);
