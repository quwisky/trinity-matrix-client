import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CODE_JOB_IDS,
  DOCS_JOB_IDS,
  classifyChangedPaths,
  classifyEvent,
  expectedJobsForMode,
  gitDiff,
} from './ci-classify.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe('CI change classifier', () => {
  it('classifies an allowed documentation-only PR as docs', () => {
    expect(
      classifyEvent(
        'pull_request',
        {
          pull_request: { base: { sha: SHA_A }, head: { sha: SHA_B } },
        },
        { diff: () => ['docs/users/guide.md', 'docs/index.md'] },
      ),
    ).toEqual({
      mode: 'docs',
      reason: 'documentation-only changes',
      expectedJobs: DOCS_JOB_IDS,
    });
  });

  it('classifies code mixed with docs as code', () => {
    expect(
      classifyChangedPaths(['docs/index.md', 'libs/util/src/index.ts']).mode,
    ).toBe('code');
  });

  it('treats a rename from code as code', () => {
    expect(classifyChangedPaths(['apps/trinity/src/app.ts']).mode).toBe('code');
  });

  it('fails closed for absent, empty, unknown, and malformed diffs', () => {
    expect(
      classifyEvent(
        'pull_request',
        { pull_request: { base: { sha: SHA_A }, head: { sha: SHA_B } } },
        { diff: () => undefined },
      ).mode,
    ).toBe('code');
    expect(
      classifyEvent(
        'pull_request',
        { pull_request: { base: { sha: SHA_A }, head: { sha: SHA_B } } },
        { diff: () => [] },
      ).mode,
    ).toBe('code');
    let called = false;
    expect(
      classifyEvent(
        'push',
        { before: '0'.repeat(40), after: SHA_B },
        {
          diff: () => {
            called = true;
            return [];
          },
        },
      ).mode,
    ).toBe('code');
    expect(called).toBe(false);
    expect(
      classifyEvent(
        'pull_request',
        { pull_request: { base: { sha: 'bad' }, head: { sha: SHA_B } } },
        { diff: () => [] },
      ).mode,
    ).toBe('code');
    expect(
      classifyChangedPaths(['docs/users/guide.md', '../package.json']).mode,
    ).toBe('code');
  });

  it('uses canonical job sets', () => {
    expect(CODE_JOB_IDS).toEqual([
      'quality',
      'unit-and-types',
      'renderer',
      'component-storybook-e2e',
      'component-styling-e2e',
      'browser-synapse-e2e',
      'qr-protocol-e2e',
      'production-renderer-e2e',
      'web-container',
      'desktop-e2e',
      'android-e2e',
      'ios-native-build',
    ]);
    expect(DOCS_JOB_IDS).toEqual(['docs-gate']);
    expect(expectedJobsForMode('code')).toEqual(CODE_JOB_IDS);
    expect(expectedJobsForMode('unknown')).toBeUndefined();
  });

  it('marks a git/diff execution failure for the evaluator', () => {
    expect(
      classifyEvent(
        'pull_request',
        { pull_request: { base: { sha: SHA_A }, head: { sha: SHA_B } } },
        {
          diff: () => {
            throw new Error('git unavailable');
          },
        },
      ),
    ).toMatchObject({ mode: 'code', classifierFailed: true });
  });

  it('uses a single merge base for a real PR diff', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ci-classify-git-'));
    try {
      const git = (args) => execFileSync('git', args, { cwd: directory });
      git(['init', '-q']);
      git(['config', 'user.email', 'test@example.invalid']);
      git(['config', 'user.name', 'Test']);
      git(['commit', '--allow-empty', '-qm', 'base']);
      const base = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: directory,
        encoding: 'utf8',
      }).trim();
      git(['commit', '--allow-empty', '-qm', 'head']);
      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: directory,
        encoding: 'utf8',
      }).trim();
      expect(gitDiff(directory, { base, head, range: 'merge-base' })).toEqual(
        [],
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
