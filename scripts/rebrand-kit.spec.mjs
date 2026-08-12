import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXCLUDED,
  SUBSTITUTIONS,
  isExcluded,
  rebrand,
  targets,
} from './rebrand-kit.mjs';

const workspaceRoot = join(import.meta.dirname, '..');

/**
 * The codemod exists to survive a `@spartan-ng/cli` re-sync: generate, re-run this, commit.
 * That only works if it is idempotent and if its exclusions hold, so both are asserted here
 * rather than trusted — a substitution that is not a fixpoint corrupts the tree the second
 * time someone runs it, and the two exclusions each destroy something that fails silently.
 */
describe('rebrand-kit', () => {
  it('is idempotent — the working tree is already a fixpoint', () => {
    // The acceptance criterion for #150, expressed as a test: re-running the codemod must
    // produce no change at all. Read from disk rather than from `git show HEAD:` — the
    // criterion is about the tree as it stands, and reading HEAD would make the test pass
    // or fail on whether the rebrand happens to be committed yet.
    const dirty = targets(workspaceRoot).filter((file) => {
      let source;
      try {
        source = readFileSync(join(workspaceRoot, file), 'utf8');
      } catch {
        return false; // binary or unreadable — the codemod skips it too
      }
      return rebrand(source) !== source;
    });

    expect(dirty).toEqual([]);
  });

  it('rewrites a prefix, never a whole name', () => {
    // The property that makes the codemod affordable and re-runnable. `hlmBtn` -> `trnBtn`,
    // NOT `trnButton`: the moment it starts improving names it stops being mechanical.
    expect(rebrand('hlmBtn')).toBe('trnBtn');
    expect(rebrand('HlmSelectValuesContent')).toBe('TrnSelectValuesContent');
    expect(rebrand("from '@trinity/helm/button'")).toBe(
      "from '@trinity/kit/button'",
    );
    expect(rebrand('libs/spartan/overlay')).toBe('libs/kit/overlay');
  });

  it('applies its own output unchanged a second time', () => {
    const once = rebrand(
      'HlmButton hlmBtn @trinity/helm/button libs/spartan/x',
    );
    expect(rebrand(once)).toBe(once);
  });

  it('excludes the vendored upstream skill and the lockfile', () => {
    // .agents is hash-pinned in skills-lock.json and documents components this repo does
    // not vendor; pnpm-lock.yaml carries the literal `hlm` inside a sha512 integrity hash.
    // Both corrupt silently rather than loudly, which is why they are asserted.
    expect(EXCLUDED).toEqual([
      '.agents/',
      'pnpm-lock.yaml',
      'scripts/rebrand-kit.mjs',
      'scripts/rebrand-kit.spec.mjs',
    ]);
    // Self-exclusion is not tidiness: this file quotes the old identifiers as fixtures and
    // the codemod quotes them as substitution sources, so a run over either destroys it.
    expect(isExcluded('scripts/rebrand-kit.mjs')).toBe(true);
    expect(isExcluded('.agents/skills/spartan/SKILL.md')).toBe(true);
    expect(isExcluded('pnpm-lock.yaml')).toBe(true);
    expect(isExcluded('libs/kit/button/src/lib/trn-button.ts')).toBe(false);
    expect(targets(workspaceRoot).some(isExcluded)).toBe(false);
  });

  it('resolves the avatar collision in the kit, and ONLY in the kit', () => {
    // Trinity's `<trn-avatar>` in libs/ui wraps the kit's avatar primitive, so a pure
    // substitution puts two components on one tag — NG8023, which only `pnpm build` catches.
    // The primitive yields. Applied unscoped this rewrites libs/ui's own declaration too and
    // the element ceases to exist (NG8001); that is a bug this branch actually shipped for
    // one build, hence the second assertion.
    const decl = "selector: 'trn-avatar'";
    expect(rebrand(decl, 'libs/kit/avatar/src/lib/trn-avatar.ts')).toBe(
      "selector: 'trn-avatar-root'",
    );
    expect(rebrand(decl, 'libs/ui/src/lib/avatar/avatar.component.ts')).toBe(
      decl,
    );
    // Still a fixpoint: the trailing quote stops it matching its own output.
    expect(
      rebrand("selector: 'trn-avatar-root'", 'libs/kit/avatar/src/lib/x.ts'),
    ).toBe("selector: 'trn-avatar-root'");
  });

  it('orders the alias substitution before the bare prefix', () => {
    // `@trinity/helm` has to be consumed before anything shorter could bite into it.
    expect(SUBSTITUTIONS[0][0]).toBe('@trinity/helm');
  });
});
