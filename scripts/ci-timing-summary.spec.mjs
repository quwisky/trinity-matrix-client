import { describe, expect, it } from 'vitest';
import {
  collectAttemptJobs,
  elapsedSeconds,
  renderTimingSummary,
} from './ci-timing-summary.mjs';

describe('CI timing summary', () => {
  it('renders exact job and step outcomes without summing overlap', () => {
    const summary = renderTimingSummary(
      [
        {
          name: 'reusable / Android (shard 1/4)',
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-01-01T00:00:00Z',
          completed_at: '2026-01-01T00:02:00Z',
          steps: [
            {
              name: 'build',
              status: 'completed',
              started_at: '2026-01-01T00:00:10Z',
              completed_at: '2026-01-01T00:01:10Z',
            },
            { name: 'missing timestamps', status: 'in_progress' },
          ],
        },
        { name: 'canceled job', status: 'completed', conclusion: 'cancelled' },
        { name: 'skipped job', status: 'completed', conclusion: 'skipped' },
      ],
      'Nightly timing',
    );
    expect(summary).toContain('reusable / Android (shard 1/4)');
    expect(summary).toContain('60.0s');
    expect(summary).toContain('unavailable');
    expect(summary).toContain('cancelled');
    expect(summary).toContain('skipped');
    expect(summary).not.toContain('180.0s');
  });

  it('rejects invalid or negative timestamps as unavailable', () => {
    expect(elapsedSeconds('bad', '2026-01-01T00:00:00Z')).toBeNull();
    expect(
      elapsedSeconds('2026-01-01T00:01:00Z', '2026-01-01T00:00:00Z'),
    ).toBeNull();
  });

  it('paginates the exact attempt and preserves all returned jobs', async () => {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      return {
        ok: true,
        json: async () => ({
          total_count: 101,
          jobs:
            page === 1
              ? Array.from({ length: 100 }, (_, i) => ({
                  id: i + 1,
                  run_id: 42,
                  run_attempt: 3,
                }))
              : [{ id: 101, run_id: 42, run_attempt: 3 }],
        }),
      };
    };
    const jobs = await collectAttemptJobs({
      repository: 'example/project',
      runId: '42',
      attempt: '3',
      token: 'token',
      fetchImpl,
    });
    expect(jobs).toHaveLength(101);
    expect(urls).toEqual([
      'https://api.github.com/repos/example/project/actions/runs/42/attempts/3/jobs?per_page=100&page=1',
      'https://api.github.com/repos/example/project/actions/runs/42/attempts/3/jobs?per_page=100&page=2',
    ]);
  });

  it('rejects incomplete, duplicate, and wrong-attempt API records', async () => {
    const collect = (payload) =>
      collectAttemptJobs({
        repository: 'example/project',
        runId: '42',
        attempt: '3',
        token: 'token',
        fetchImpl: async () => ({ ok: true, json: async () => payload }),
      });
    await expect(
      collect({
        total_count: 2,
        jobs: [{ id: 1, run_id: 42, run_attempt: 3 }],
      }),
    ).rejects.toThrow('incomplete');
    await expect(
      collect({
        total_count: 2,
        jobs: [
          { id: 1, run_id: 42, run_attempt: 3 },
          { id: 1, run_id: 42, run_attempt: 3 },
        ],
      }),
    ).rejects.toThrow('duplicate');
    await expect(
      collect({
        total_count: 1,
        jobs: [{ id: 1, run_id: 42, run_attempt: 2 }],
      }),
    ).rejects.toThrow('another attempt');
  });

  it('aborts a hung request at the single collection deadline', async () => {
    await expect(
      collectAttemptJobs({
        repository: 'example/project',
        runId: '42',
        attempt: '3',
        token: 'token',
        deadlineMs: 5,
        fetchImpl: () => new Promise(() => {}),
      }),
    ).rejects.toThrow('deadline exceeded');
  });
});
