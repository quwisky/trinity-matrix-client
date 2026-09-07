import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { E2E_SUITES } from '../e2e/registry/index.mts';
import {
  plan,
  prepare,
  run,
  suiteForId,
  validateCoordinates,
} from './ci-e2e-suite.mjs';
import { currentCommit } from './web-bundle-manifest.mjs';

const sha = currentCommit();
const base = { CI_E2E_SHA: sha };
const renderer = {
  ...base,
  CI_RENDERER_SOURCE_RUN_ID: '99',
  CI_RENDERER_ARTIFACT_ID: '100',
  CI_RENDERER_ARTIFACT_NAME: `renderer-99-1-${sha}`,
  CI_RENDERER_MANIFEST_DIGEST: 'a'.repeat(64),
};
const ids = [
  'components.storybook',
  'components.styling',
  'browser.canonical',
  'protocol.verify-qr',
  'web.production-renderer',
];
const directories = [];
afterEach(() =>
  directories
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);

const successful = (spec) =>
  Promise.resolve({ label: spec.label, exitCode: 0 });

describe('reusable browser CI policy', () => {
  it('admits exactly the five registry preparations and rejects every other suite', () => {
    expect(
      E2E_SUITES.filter((suite) => suite.ciPreparation)
        .map(({ id }) => id)
        .sort(),
    ).toEqual([...ids].sort());
    for (const suite of E2E_SUITES) {
      if (ids.includes(suite.id)) expect(suiteForId(suite.id)).toBe(suite);
      else
        expect(() => suiteForId(suite.id)).toThrow(
          /Unknown reusable browser CI suite/,
        );
    }
    expect(() => suiteForId('unknown')).toThrow(/Unknown/);
  });

  it('derives each build, browser list, report path and timeout from its registry owner', () => {
    for (const id of ids) {
      const suite = suiteForId(id);
      const details = plan(
        id,
        id === 'web.production-renderer' ? renderer : base,
      );
      expect(details.currentTarget).toBe(suite.currentTarget);
      expect(details.reportPath).toBe(
        `${suite.targetArtifactRoot.replace('<run-id>', '*')}/${id}/**`,
      );
      expect(details.timeoutMs).toBeGreaterThan(0);
    }
    expect(plan('components.storybook', base)).toMatchObject({
      browsers: ['chromium', 'webkit'],
      buildTarget: 'components-storybook-host:build-storybook',
      requiresRenderer: false,
    });
    expect(plan('web.production-renderer', renderer)).toMatchObject({
      buildTarget: null,
      requiresRenderer: true,
    });
  });

  it.each(['short', 'f'.repeat(40), `${sha}\n`])(
    'rejects invalid or wrong checkout SHA %s before any prerequisite starts',
    async (value) => {
      const execute = vi.fn(successful);
      await expect(
        prepare('browser.canonical', {
          environment: { CI_E2E_SHA: value },
          run: execute,
        }),
      ).rejects.toThrow(/exact full checkout SHA/);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('rejects each missing or malformed renderer coordinate', () => {
    const suite = suiteForId('web.production-renderer');
    for (const key of Object.keys(renderer).filter(
      (name) => name !== 'CI_E2E_SHA',
    )) {
      expect(() =>
        validateCoordinates(suite, { ...renderer, [key]: '' }),
      ).toThrow(/requires all/);
      expect(() =>
        validateCoordinates(suite, { ...renderer, [key]: 'bad/value' }),
      ).toThrow(/Renderer requires/);
      expect(() =>
        validateCoordinates(suiteForId('browser.canonical'), {
          ...base,
          [key]: renderer[key],
        }),
      ).toThrow(/does not accept/);
    }
    expect(validateCoordinates(suite, renderer)).toEqual({
      sha,
      requiresRenderer: true,
    });
  });

  it('prepares Storybook without a development application build or Docker', async () => {
    const execute = vi.fn(successful);
    expect(
      (
        await prepare('components.storybook', {
          environment: base,
          run: execute,
        })
      ).exitCode,
    ).toBe(0);
    const calls = execute.mock.calls.map(([spec]) => spec);
    expect(calls.map(({ command, args }) => [command, ...args])).toEqual([
      [
        'pnpm',
        'exec',
        'playwright',
        'install',
        '--with-deps',
        'chromium',
        'webkit',
      ],
      [
        'pnpm',
        'exec',
        'nx',
        'run',
        'components-storybook-host:build-storybook',
      ],
    ]);
  });

  it('prepares production browsers and Synapse without compiling either renderer', async () => {
    const execute = vi.fn(successful);
    await prepare('web.production-renderer', {
      environment: renderer,
      run: execute,
    });
    const calls = execute.mock.calls.map(([spec]) => [
      spec.command,
      ...spec.args,
    ]);
    expect(calls).toEqual([
      [
        'pnpm',
        'exec',
        'playwright',
        'install',
        '--with-deps',
        'chromium',
        'webkit',
      ],
      [
        'docker',
        'compose',
        '-f',
        'e2e/support/synapse/docker-compose.yml',
        'pull',
        '-q',
      ],
    ]);
  });

  it.each(['components.styling', 'browser.canonical', 'protocol.verify-qr'])(
    'prepares the owned development build for %s',
    async (id) => {
      const execute = vi.fn(successful);
      await prepare(id, { environment: base, run: execute });
      expect(execute.mock.calls.map(([spec]) => spec.args)).toContainEqual([
        'exec',
        'nx',
        'run',
        'trinity:build:development',
      ]);
      expect(
        execute.mock.calls.some(([spec]) => spec.command === 'docker'),
      ).toBe(id !== 'components.styling');
    },
  );

  it('dispatches the registered Nx target with managed timeout, cancellation and strict flaky policy', async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => ({ exitCode: 7 }));
    expect(
      await run('browser.canonical', {
        environment: base,
        execute,
        signal: controller.signal,
      }),
    ).toBe(7);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        command: 'pnpm',
        args: [
          'exec',
          'nx',
          'run',
          'trinity-e2e-browser:e2e',
          '--',
          '--fail-on-flaky-tests',
        ],
        env: base,
        timeoutMs: plan('browser.canonical', base).timeoutMs,
        abortSignal: controller.signal,
        label: 'suite-browser.canonical',
      }),
    );
    expect(
      await run('browser.canonical', {
        environment: base,
        execute: async () => ({ exitCode: 0, timedOut: true }),
      }),
    ).toBe(124);
  });

  it('refuses a production run before artifact restoration instead of rebuilding it', async () => {
    const execute = vi.fn(successful);
    await expect(
      run('web.production-renderer', { environment: renderer, execute }),
    ).rejects.toThrow(/Restore the verified/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('emits literal GitHub outputs through the CLI and rejects an extra suite argument', () => {
    const directory = mkdtempSync(join(tmpdir(), 'trinity-ci-suite-'));
    directories.push(directory);
    const output = join(directory, 'output');
    const command = join(import.meta.dirname, 'ci-e2e-suite.mjs');
    const env = {
      ...process.env,
      ...base,
      CI_E2E_SUITE: 'components.storybook',
      GITHUB_OUTPUT: output,
    };
    const result = spawnSync(process.execPath, [command, 'plan'], {
      env,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, 'utf8')).toContain(
      'browsers=chromium webkit\n',
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      suiteId: 'components.storybook',
    });
    const invalid = spawnSync(
      process.execPath,
      [command, 'plan', 'web.container'],
      { env, encoding: 'utf8' },
    );
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('usage:');
  });
});
