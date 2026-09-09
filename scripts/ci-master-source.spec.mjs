import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateMasterSource,
  fetchPullRequest,
  main,
  TRUSTED_REPOSITORY,
  validateMasterSourceEvent,
} from './ci-master-source.mjs';

const repository = {
  id: TRUSTED_REPOSITORY.id,
  full_name: TRUSTED_REPOSITORY.fullName,
};
const event = (overrides = {}) => ({
  repository,
  pull_request: {
    number: 42,
    base: { ref: 'master', repo: repository },
    head: {
      ref: 'develop',
      sha: 'a'.repeat(40),
      repo: repository,
    },
    ...overrides,
  },
});
const api = (overrides = {}) => ({
  number: 42,
  state: 'open',
  base: { ref: 'master', repo: repository },
  head: { ref: 'develop', sha: 'a'.repeat(40), repo: repository },
  ...overrides,
});

describe('master promotion source guard', () => {
  it('accepts only a same-repository develop to master PR with fresh SHA', () => {
    expect(
      evaluateMasterSource({ event: event(), pullRequest: api() }),
    ).toEqual({
      ok: true,
      applicable: true,
      failures: [],
    });
  });

  it.each([
    [
      'fork head',
      {
        head: {
          ref: 'develop',
          sha: 'a'.repeat(40),
          repo: { id: 9, full_name: 'someone/trinity-matrix-client' },
        },
      },
      api(),
    ],
    [
      'branch spoof',
      { head: { ref: 'develop', sha: 'a'.repeat(40), repo: repository } },
      api({
        head: {
          ref: 'develop',
          sha: 'a'.repeat(40),
          repo: { id: 9, full_name: 'someone/trinity-matrix-client' },
        },
      }),
    ],
    [
      'stale API SHA',
      {},
      api({ head: { ref: 'develop', sha: 'b'.repeat(40), repo: repository } }),
    ],
    [
      'missing repository ID',
      {},
      api({
        head: {
          ref: 'develop',
          sha: 'a'.repeat(40),
          repo: { full_name: repository.full_name },
        },
      }),
    ],
    [
      'wrong base repository',
      {
        base: {
          ref: 'master',
          repo: { id: 9, full_name: 'someone/trinity-matrix-client' },
        },
      },
      api(),
    ],
  ])('rejects %s', (_name, eventOverrides, pullRequest) => {
    expect(
      evaluateMasterSource({ event: event(eventOverrides), pullRequest }).ok,
    ).toBe(false);
  });

  it('treats a well-formed non-master PR and push as explicitly not applicable', () => {
    expect(
      evaluateMasterSource({
        event: event({ base: { ref: 'develop', repo: repository } }),
        pullRequest: api({ base: { ref: 'develop', repo: repository } }),
      }),
    ).toEqual({ ok: true, applicable: false, failures: [] });
    expect(evaluateMasterSource({ event: {} })).toEqual({
      ok: true,
      applicable: false,
      failures: [],
    });
  });

  it('allows a fresh fork head for an ordinary develop PR', () => {
    const fork = { id: 9, full_name: 'contributor/trinity-matrix-client' };
    expect(
      evaluateMasterSource({
        event: event({
          base: { ref: 'develop', repo: repository },
          head: { ref: 'feature', sha: 'a'.repeat(40), repo: fork },
        }),
        pullRequest: api({
          base: { ref: 'develop', repo: repository },
          head: { ref: 'feature', sha: 'a'.repeat(40), repo: fork },
        }),
      }),
    ).toEqual({ ok: true, applicable: false, failures: [] });
  });

  it('rejects a PR retargeted to master when the fresh API still says develop', () => {
    expect(
      evaluateMasterSource({
        event: event({ base: { ref: 'master', repo: repository } }),
        pullRequest: api({ base: { ref: 'develop', repo: repository } }),
      }),
    ).toMatchObject({ ok: false });
  });

  it('rejects startup races that change the API base or head identity', () => {
    expect(
      evaluateMasterSource({
        event: event(),
        pullRequest: api({
          head: { ref: 'develop', sha: 'b'.repeat(40), repo: repository },
        }),
      }),
    ).toMatchObject({ ok: false });
    expect(
      evaluateMasterSource({
        event: event(),
        pullRequest: api({
          base: { ref: 'master', repo: { id: 9, full_name: 'fork/repo' } },
        }),
      }),
    ).toMatchObject({ ok: false });
  });

  it('fetches fresh metadata before deciding a non-master PR is irrelevant', () => {
    const directory = mkdtempSync(join(tmpdir(), 'trinity-source-'));
    const eventPath = join(directory, 'event.json');
    const summaryPath = join(directory, 'summary.md');
    writeFileSync(
      eventPath,
      JSON.stringify(event({ base: { ref: 'develop', repo: repository } })),
    );
    const calls = [];
    const result = main({
      env: {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: TRUSTED_REPOSITORY.fullName,
        GITHUB_STEP_SUMMARY: summaryPath,
      },
      runApi: (...args) => {
        calls.push(args);
        return api();
      },
    });
    expect(calls).toEqual([[TRUSTED_REPOSITORY.fullName, 42]]);
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
  });

  it('requires a complete pinned Bot identity for the disabled Release Please hook', () => {
    const release = {
      appId: 15368,
      botUserId: 123,
      slug: 'release-please',
    };
    const releaseEvent = event({
      head: { ref: 'release-please--1', sha: 'a'.repeat(40), repo: repository },
    });
    const releaseApi = api({
      head: { ref: 'release-please--1', sha: 'a'.repeat(40), repo: repository },
      user: { type: 'Bot', id: 123, login: 'release-please[bot]' },
    });
    expect(
      evaluateMasterSource({
        event: releaseEvent,
        pullRequest: releaseApi,
        releaseAppIdentity: release,
      }),
    ).toEqual({
      ok: true,
      applicable: true,
      failures: [],
    });
    expect(
      evaluateMasterSource({
        event: releaseEvent,
        pullRequest: releaseApi,
      }).ok,
    ).toBe(false);
    expect(
      evaluateMasterSource({
        event: releaseEvent,
        pullRequest: releaseApi,
        releaseAppIdentity: { slug: 'release-please' },
      }).ok,
    ).toBe(false);
    expect(
      evaluateMasterSource({
        event: releaseEvent,
        pullRequest: releaseApi,
        releaseAppIdentity: { ...release, botUserId: 456 },
      }).ok,
    ).toBe(false);
    expect(
      evaluateMasterSource({
        event: releaseEvent,
        pullRequest: {
          ...releaseApi,
          user: { type: 'User', id: 123, login: 'release-please[bot]' },
        },
        releaseAppIdentity: release,
      }).ok,
    ).toBe(false);
  });

  it('uses an injected read-only API collector without constructing a shell command', () => {
    const calls = [];
    const result = fetchPullRequest({
      repository: TRUSTED_REPOSITORY.fullName,
      number: 42,
      runApi: (...args) => {
        calls.push(args);
        return api();
      },
    });
    expect(result.number).toBe(42);
    expect(calls).toEqual([[TRUSTED_REPOSITORY.fullName, 42]]);
  });

  it('uses the authoritative event name, calls fresh API for a valid master PR, and summarizes success', () => {
    const directory = mkdtempSync(join(tmpdir(), 'trinity-source-'));
    const eventPath = join(directory, 'event.json');
    const summaryPath = join(directory, 'summary.md');
    writeFileSync(eventPath, JSON.stringify(event()));
    const calls = [];
    const result = main({
      env: {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: TRUSTED_REPOSITORY.fullName,
        GITHUB_STEP_SUMMARY: summaryPath,
      },
      runApi: (...args) => {
        calls.push(args);
        return api();
      },
    });
    expect(result).toMatchObject({ ok: true, applicable: true, exitCode: 0 });
    expect(calls).toEqual([[TRUSTED_REPOSITORY.fullName, 42]]);
    expect(readFileSync(summaryPath, 'utf8')).toContain('validated');
  });

  it('summarizes API failures and rejects malformed PR scope', () => {
    const directory = mkdtempSync(join(tmpdir(), 'trinity-source-'));
    const eventPath = join(directory, 'event.json');
    const summaryPath = join(directory, 'summary.md');
    writeFileSync(eventPath, JSON.stringify(event()));
    const result = main({
      env: {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: TRUSTED_REPOSITORY.fullName,
        GITHUB_STEP_SUMMARY: summaryPath,
      },
      runApi: () => {
        throw new Error('API unavailable');
      },
    });
    expect(result).toEqual({ ok: false, exitCode: 1 });
    expect(readFileSync(summaryPath, 'utf8')).toContain('API read failed');
    expect(
      validateMasterSourceEvent({ event: {}, eventName: 'pull_request' }).ok,
    ).toBe(false);
    expect(
      validateMasterSourceEvent({
        event: event({ base: {} }),
        eventName: 'pull_request',
      }).ok,
    ).toBe(false);
  });
});
