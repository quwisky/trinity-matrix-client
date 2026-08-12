#!/usr/bin/env node
/**
 * Normalises the vendored spartan-ng kit onto Trinity's own naming.
 *
 * Pure prefix substitutions, nothing else:
 *
 *   hlm            -> trn            (symbols, selectors, css classes)
 *   Hlm            -> Trn
 *   HLM            -> TRN            (SCREAMING_CASE consts, e.g. HLM_CHECKBOX_…)
 *   @trinity/helm  -> @trinity/kit   (path alias)
 *   libs/spartan   -> libs/kit       (directory)
 *
 * Being a *prefix* substitution rather than a rename is what makes this affordable and
 * re-runnable: `hlmBtn` becomes `trnBtn`, never `trnButton`. So after a
 * `nx g @spartan-ng/cli:ui <component>` re-sync, this is one command rather than a merge —
 * which is the whole reason it lives in the repo instead of being a one-off. Do not teach
 * it to "improve" a name; the moment it stops being mechanical it stops being re-runnable.
 *
 * Run from the workspace root:  node scripts/rebrand-kit.mjs [--dry]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Paths this must never touch.
 *
 * `.agents/skills/spartan/**` is the vendored UPSTREAM spartan-ng skill: it is hash-pinned
 * in skills-lock.json, and it documents components this repo does not vendor at all
 * (`hlmField`, `hlmSkeleton`, `hlmTabsTrigger`, …). Rewriting it corrupts the hash and makes
 * the skill lie about the library it describes.
 *
 * `pnpm-lock.yaml` contains the literal `hlm` inside a `sha512-…` integrity hash, so a naive
 * substitution silently corrupts the lockfile.
 */
export const EXCLUDED = [
  '.agents/',
  'pnpm-lock.yaml',
  // Itself, and its spec. Both quote the OLD identifiers as substitution sources and test
  // fixtures, so a run over them rewrites `['@trinity/helm', '@trinity/kit']` into
  // `['@trinity/kit', '@trinity/kit']` and the tool quietly stops working. It only survived
  // the first run because it was still untracked and `git ls-files` never listed it.
  'scripts/rebrand-kit.mjs',
  'scripts/rebrand-kit.spec.mjs',
];

/** Applied in order. Longest-first so `@trinity/helm` wins before a bare `helm` would. */
export const SUBSTITUTIONS = [
  ['@trinity/helm', '@trinity/kit'],
  ['libs/spartan', 'libs/kit'],
  ['HLM', 'TRN'],
  ['Hlm', 'Trn'],
  ['hlm', 'trn'],
];

export const isExcluded = (path) =>
  EXCLUDED.some((prefix) => path === prefix || path.startsWith(prefix));

/**
 * The one place a pure prefix substitution is not enough.
 *
 * Trinity's own `AvatarComponent` in `libs/ui` has been `<trn-avatar>` since long before this
 * rebrand, and it WRAPS the kit's avatar primitive. Renaming `hlm-avatar` to `trn-avatar`
 * therefore puts two components on one tag in the wrapper's own template — NG8023, caught by
 * `pnpm build` and by nothing else. The generated primitive yields, because its element name
 * is mechanical while `<trn-avatar>` is used in 32 templates and named in the docs.
 *
 * Applied here rather than hand-edited in the kit so a `@spartan-ng/cli` re-sync cannot
 * silently reintroduce the clash: the generator re-emits `hlm-avatar`, and this maps it
 * again. Keep this list empty if you possibly can — it is the seam where the codemod stops
 * being purely mechanical.
 */
export const COLLISIONS = [
  ["selector: 'trn-avatar'", "selector: 'trn-avatar-root'"],
];

export const rebrand = (source, file = '') => {
  const substituted = SUBSTITUTIONS.reduce(
    (text, [from, to]) => text.split(from).join(to),
    source,
  );
  // Collisions are resolved in the KIT only. Applied everywhere, this rewrites the very
  // declaration it exists to protect — `libs/ui`'s own `selector: 'trn-avatar'` — and the
  // element stops existing. Which is exactly what happened the first time.
  if (!file.startsWith('libs/kit/')) return substituted;
  return COLLISIONS.reduce(
    (text, [from, to]) => text.split(from).join(to),
    substituted,
  );
};

/** Every tracked, non-excluded file. Binary files are skipped by `git grep -I` upstream. */
export const targets = (cwd) =>
  execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((file) => !isExcluded(file));

const main = () => {
  const dry = process.argv.includes('--dry');
  const cwd = process.cwd();
  let changed = 0;

  for (const file of targets(cwd)) {
    const path = join(cwd, file);
    let source;
    try {
      source = readFileSync(path, 'utf8');
    } catch {
      continue; // unreadable or binary — nothing to rewrite
    }
    const next = rebrand(source, file);
    if (next === source) continue;
    changed += 1;
    if (!dry) writeFileSync(path, next);
  }

  console.error(
    `${dry ? 'would rewrite' : 'rewrote'} ${changed} file${changed === 1 ? '' : 's'}`,
  );
};

if (process.argv[1] && process.argv[1].endsWith('rebrand-kit.mjs')) main();
