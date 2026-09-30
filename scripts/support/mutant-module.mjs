import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const cacheRoot = resolve(
  import.meta.dirname,
  '../../node_modules/.cache/trinity-guard-mutants',
);
const RELATIVE = /(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+)\2/gu;

/**
 * Import a mutated copy of `original` from a private directory outside every scanned
 * source tree (guards walk e2e/ concurrently, so a mutant written there races them).
 * Relative specifiers keep resolving to the ORIGINAL siblings; a sibling listed in
 * `companions` ({ [originalPath]: mutatedSource }) resolves to its mutant instead.
 * The directory is removed afterwards, also when `run` throws.
 */
export async function withMutantModule(
  { original, source, companions = {} },
  run,
) {
  const directory = join(
    cacheRoot,
    `${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  const tempOf = new Map(
    Object.keys(companions).map((path, index) => [
      resolve(path),
      join(directory, `companion-${index}-${basename(path)}`),
    ]),
  );
  const used = new Set();
  const rewrite = (text, from) =>
    text.replace(RELATIVE, (_, lead, quote, specifier) => {
      const target = resolve(dirname(from), specifier);
      const companion = tempOf.get(target);
      if (companion) used.add(target);
      const url = companion
        ? pathToFileURL(companion).href
        : pathToFileURL(target).href;
      return `${lead}${quote}${url}${quote}`;
    });
  try {
    await mkdir(directory, { recursive: true });
    const path = join(directory, basename(original));
    for (const [companionOriginal, companionTemp] of tempOf) {
      await writeFile(
        companionTemp,
        rewrite(companions[companionOriginal], companionOriginal),
      );
    }
    await writeFile(path, rewrite(source, resolve(original)));
    for (const target of tempOf.keys()) {
      if (!used.has(target)) {
        throw new Error(`Companion mutant is never imported: ${target}`);
      }
    }
    return await run(await import(pathToFileURL(path).href), {
      directory,
      path,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
