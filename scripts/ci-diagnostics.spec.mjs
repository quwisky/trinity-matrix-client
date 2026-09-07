import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { validateReports } from './ci-diagnostics.mjs';

const roots = [];
const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'trinity-ci-diagnostics-'));
  roots.push(root);
  return root;
};
const write = (root, path, contents = 'report') => {
  const file = join(root, path);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, contents);
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('validateReports', () => {
  it('finds reports below hidden roots for each suite glob', () => {
    const root = makeRoot();
    write(
      root,
      'dist/.playwright/trinity-e2e-browser/run-1/suite/html/index.html',
    );
    write(
      root,
      'dist/.playwright/trinity-e2e-components/run-2/suite/junit/results.xml',
    );

    expect(
      validateReports({
        root,
        reportPath: [
          'dist/.playwright/trinity-e2e-browser/*/suite/**',
          'dist/.playwright/trinity-e2e-components/*/suite/**',
        ].join('\n'),
      }),
    ).toEqual(
      expect.arrayContaining([
        'dist/.playwright/trinity-e2e-browser/run-1/suite/html/index.html',
        'dist/.playwright/trinity-e2e-components/run-2/suite/junit/results.xml',
      ]),
    );
  });

  it('fails when a report root is missing', () => {
    const root = makeRoot();

    expect(() =>
      validateReports({
        root,
        reportPath: 'dist/.playwright/trinity-e2e-browser/*/suite/**',
      }),
    ).toThrow(/no report files matched/iu);
  });

  it('does not treat a directory or retained log as a report', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'dist/.playwright/trinity-e2e-browser/run-1/suite'), {
      recursive: true,
    });
    write(root, 'dist/.playwright/trinity-e2e-browser/run-1/suite/command.log');

    expect(() =>
      validateReports({
        root,
        reportPath: 'dist/.playwright/trinity-e2e-browser/*/suite/report.html',
      }),
    ).toThrow(/no report files matched/iu);
    expect(() =>
      validateReports({
        root,
        reportPath: 'dist/.playwright/trinity-e2e-browser/*/suite/**',
      }),
    ).toThrow(/no report files matched/iu);
    write(root, 'dist/.playwright/trinity-e2e-browser/run-1/suite/trace.zip');
    expect(
      validateReports({
        root,
        reportPath: 'dist/.playwright/trinity-e2e-browser/*/suite/**',
      }),
    ).toContain('dist/.playwright/trinity-e2e-browser/run-1/suite/trace.zip');
  });

  it('does not treat JSON-only preflight output as a report', () => {
    const root = makeRoot();
    write(root, 'dist/.playwright/project/run-1/suite/summary.json');

    expect(() =>
      validateReports({
        root,
        reportPath: 'dist/.playwright/project/*/suite/**',
      }),
    ).toThrow(/no report files matched/iu);
  });
});
