/** CodeQL's overlay base databases must not fill the Actions cache and evict everything else. */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workflow as loadWorkflow } from './workspace-sources.mjs';

const workflow = loadWorkflow('codeql.yml');
const job = workflow.jobs['prune-overlay-caches'];
const script = job.steps[0].run;

const entry = (id, language, createdAt) => ({
  id,
  key: `codeql-overlay-base-database-1-673738e94a8102ad-${language}-2.27.2-bb50b7950e7f2a102a8ae71df1727d3a78dba705-${id}-1`,
  createdAt,
});

/** Run the step against a fake `gh` that lists `caches` and records each delete. */
function prune(caches) {
  const dir = mkdtempSync(join(tmpdir(), 'codeql-prune-'));
  const deleted = join(dir, 'deleted');
  writeFileSync(join(dir, 'caches.json'), JSON.stringify(caches));
  writeFileSync(
    join(dir, 'gh'),
    `#!/bin/bash
set -e
if [ "$1 $2" = "cache delete" ]; then echo "$3" >> "${deleted}"; exit 0; fi
[ "$1 $2" = "cache list" ]
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) [ "$2" = refs/heads/main ] ;;
    --key) [ "$2" = codeql-overlay-base-database- ] ;;
    --jq) filter="$2" ;;
  esac
  shift
done
jq -r "$filter" "${dir}/caches.json"
`,
  );
  chmodSync(join(dir, 'gh'), 0o755);
  const result = spawnSync('bash', ['-e', '-c', script], {
    env: { PATH: `${dir}:${process.env.PATH}` },
    encoding: 'utf8',
  });
  let ids = [];
  try {
    ids = readFileSync(deleted, 'utf8').trim().split('\n');
  } catch {
    // Nothing deleted.
  }
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, stderr: result.stderr, ids };
}

describe('CodeQL overlay cache pruning', () => {
  it('runs after the analyses on main only, with no more than cache write access', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(job.needs).toBe('analyze');
    expect(job.if).toBe(
      "${{ !cancelled() && github.ref == 'refs/heads/main' && github.event_name != 'pull_request' }}",
    );
    expect(job.permissions).toEqual({ actions: 'write' });
    expect(job.steps).toHaveLength(1);
    expect(job.steps[0].env).toEqual({
      GH_TOKEN: '${{ github.token }}',
      GH_REPO: '${{ github.repository }}',
    });
    // Expressions go through `env:`; a `${{ }}` inside `run:` would be shell-injectable.
    expect(script).not.toContain('${{');
  });

  it('keeps the newest database per language and deletes the rest', () => {
    const { status, stderr, ids } = prune([
      entry(1, 'javascript', '2026-10-18T10:00:00Z'),
      entry(2, 'java', '2026-10-19T10:00:00Z'),
      entry(3, 'javascript', '2026-10-20T10:00:00Z'),
      entry(4, 'java', '2026-10-18T10:00:00Z'),
      entry(5, 'javascript', '2026-10-19T10:00:00Z'),
    ]);
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(ids.sort()).toEqual(['1', '4', '5']);
  });

  it('deletes nothing when each language has one database', () => {
    expect(
      prune([
        entry(1, 'javascript', '2026-10-20T10:00:00Z'),
        entry(2, 'java', '2026-10-20T10:00:00Z'),
      ]),
    ).toEqual({ status: 0, stderr: '', ids: [] });
    expect(prune([])).toEqual({ status: 0, stderr: '', ids: [] });
  });
});

describe('CodeQL Rust analysis', () => {
  const analyze = workflow.jobs.analyze;
  const rust = workflow.jobs.rust;
  const initOf = (candidate) =>
    candidate.steps.find((step) =>
      step.uses?.startsWith('github/codeql-action/init@'),
    );
  const analyzeOf = (candidate) =>
    candidate.steps.find((step) =>
      step.uses?.startsWith('github/codeql-action/analyze@'),
    );
  const gate = "${{ hashFiles('**/*.rs') != '' }}";

  it('analyses Rust without a build, under its own category, with the file pinned actions', () => {
    expect(initOf(rust).with).toEqual({
      languages: 'rust',
      'build-mode': 'none',
    });
    expect(analyzeOf(rust).with).toEqual({ category: '/language:rust' });
    expect(rust.permissions).toEqual(analyze.permissions);
    for (const step of rust.steps) {
      expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
    }
    expect(initOf(rust).uses).toBe(initOf(analyze).uses);
    expect(analyzeOf(rust).uses).toBe(analyzeOf(analyze).uses);
  });

  it('skips the analysis while the tree has no Rust source', () => {
    expect(initOf(rust)['if']).toBe(gate);
    expect(analyzeOf(rust)['if']).toBe(gate);
    expect(rust['if']).toBeUndefined();
  });

  it('adds the Rust branch to the push and pull request triggers, and the weekly run stays', () => {
    expect(workflow.on.push.branches).toEqual([
      'main',
      'feat/1153-rust-engine',
    ]);
    expect(workflow.on.pull_request.branches).toEqual([
      'main',
      'feat/1153-rust-engine',
    ]);
    expect(workflow.on.schedule).toHaveLength(1);
  });

  it('keeps every other language on main, its pull requests and the weekly run', () => {
    const onMain =
      "github.ref == 'refs/heads/main' || github.base_ref == 'main'";
    expect(analyze['if']).toBe(`\${{ ${onMain} }}`);
    expect(workflow.jobs.swift['if']).toContain(`(${onMain})`);
    expect(workflow.jobs.changes['if']).toContain("github.base_ref == 'main'");
    expect(workflow.jobs['prune-overlay-caches']['if']).toContain(
      "github.ref == 'refs/heads/main'",
    );
  });
});
