import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { protectUploadDiagnostics } from './ci-matrix-identifiers.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const eventId = `$${'aB3_-'.repeat(8)}xyz`;
const roomId = '!AbCdEfGhIjKlMnOpQr:localhost';

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'trinity-ci-identifiers-'));
  roots.push(root);
  const suite = join(
    root,
    'dist/.playwright/trinity-e2e-android/run/android.example',
  );
  mkdirSync(join(suite, 'stage/logs'), { recursive: true });
  mkdirSync(join(root, 'dist/.ci'), { recursive: true });
  writeFileSync(
    join(suite, 'stage/logs/device-logcat.txt'),
    `Event ${eventId} already in timeline\n`,
  );
  writeFileSync(
    join(suite, 'stage/current-point-1.json'),
    JSON.stringify({ selector: `.msg[data-mid="${eventId}"]` }),
  );
  writeFileSync(
    join(suite, 'stage/flow.yaml'),
    `# ${encodeURIComponent(roomId)}\n`,
  );
  writeFileSync(
    join(suite, 'stage/row.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]),
  );
  writeFileSync(
    join(root, 'dist/.ci/suite.log'),
    `[suite] stdout: /rooms/${Buffer.from(roomId).toString('base64url')}\n`,
  );
  return { root, suite };
}

describe('Android upload identifier boundary', () => {
  it('redacts every Room and event id shape from uploaded text diagnostics', async () => {
    const { root, suite } = workspace();
    const result = await protectUploadDiagnostics({
      root,
      reportPath: 'dist/.playwright/trinity-e2e-android/*/android.example/**',
    });
    expect(result.withheld).toEqual([]);
    expect(result.redacted).toHaveLength(4);
    expect(
      readFileSync(join(suite, 'stage/logs/device-logcat.txt'), 'utf8'),
    ).toBe('Event [REDACTED] already in timeline\n');
    expect(readFileSync(join(suite, 'stage/flow.yaml'), 'utf8')).toBe(
      '# [REDACTED]\n',
    );
    expect(readFileSync(join(root, 'dist/.ci/suite.log'), 'utf8')).toBe(
      '[suite] stdout: /rooms/[REDACTED]\n',
    );
    expect(existsSync(join(suite, 'stage/row.png'))).toBe(true);
  });

  it('withholds a diagnostic it cannot verify as text', async () => {
    const { root, suite } = workspace();
    writeFileSync(
      join(suite, 'stage/trace.zip'),
      Buffer.from([0x50, 0x4b, 0, 0]),
    );
    const result = await protectUploadDiagnostics({
      root,
      reportPath: 'dist/.playwright/trinity-e2e-android/*/android.example/**',
    });
    expect(result.withheld).toHaveLength(1);
    expect(existsSync(join(suite, 'stage/trace.zip'))).toBe(false);
  });

  it('rejects an empty report path', async () => {
    await expect(
      protectUploadDiagnostics({ root: tmpdir(), reportPath: '' }),
    ).rejects.toThrow(/CI_REPORT_PATH/u);
  });
});
