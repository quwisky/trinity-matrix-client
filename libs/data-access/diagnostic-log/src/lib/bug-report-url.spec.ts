import { describe, expect, it } from 'vitest';
import {
  GITHUB_ISSUE_URL_LIMIT,
  buildBugReportUrl,
  type BugReportDraft,
} from './bug-report-url';

const REPOSITORY = 'https://github.com/quwisky/trinity-matrix-client';
const FACTS = {
  version: 'Trinity v0.4.0 · 261efbe9',
  platform: 'Web, Firefox 141 on Linux',
  homeservers: ['Synapse 1.140.0'],
};

function fields(url: string | null): Record<string, string> {
  return Object.fromEntries(new URL(url as string).searchParams);
}

function draft(overrides: Partial<BugReportDraft> = {}): BugReportDraft {
  return {
    description: 'Crash on send & "reply"',
    facts: FACTS,
    logFileName: 'trinity-2026-10-11.log',
    ...overrides,
  };
}

describe('buildBugReportUrl', () => {
  it('fills the bug report form by field id', () => {
    const url = buildBugReportUrl(REPOSITORY, draft());

    expect(url?.startsWith(`${REPOSITORY}/issues/new?`)).toBe(true);
    expect(fields(url)).toEqual({
      template: 'bug_report.yml',
      summary: 'Crash on send & "reply"',
      version: 'Trinity v0.4.0 · 261efbe9',
      os: 'Web, Firefox 141 on Linux',
      homeserver: 'Synapse 1.140.0',
      logs: 'Diagnostic log: trinity-2026-10-11.log. Attach the saved file in "Other observations" below; this box is shown as code.',
    });
  });

  it('leaves out the logs field when no log file is attached', () => {
    expect(
      fields(buildBugReportUrl(REPOSITORY, draft({ logFileName: null }))),
    ).not.toHaveProperty('logs');
  });

  it('accepts a fork, a trailing slash or .git, and refuses anything but GitHub', () => {
    expect(
      buildBugReportUrl(
        'https://github.com/someone/trinity-fork.git/',
        draft(),
      ),
    ).toMatch(/^https:\/\/github\.com\/someone\/trinity-fork\/issues\/new\?/);
    expect(buildBugReportUrl('https://example.com/a/b', draft())).toBeNull();
    expect(buildBugReportUrl('javascript:alert(1)', draft())).toBeNull();
  });

  it('trims a long description to keep the URL under the limit', () => {
    const url = buildBugReportUrl(
      REPOSITORY,
      draft({ description: 'x'.repeat(20_000) }),
    );

    expect(url?.length).toBeLessThanOrEqual(GITHUB_ISSUE_URL_LIMIT);
    expect(fields(url)['summary'].endsWith('x […]')).toBe(true);
  });

  it('never splits an emoji when trimming', () => {
    const url = buildBugReportUrl(
      REPOSITORY,
      draft({ description: '😀'.repeat(5_000) }),
    );
    const summary = fields(url)['summary'];

    expect(url?.length).toBeLessThanOrEqual(GITHUB_ISSUE_URL_LIMIT);
    expect(summary).not.toContain('�');
    expect(summary.endsWith('😀 […]')).toBe(true);
  });
});
