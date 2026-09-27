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

const token = `syt_${'dGVzdA'}_${'AbCdEfGhIjKlMnOpQrSt'}_0a1B2c`;

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
  it('redacts access tokens from the retained installed-webview layout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'trinity-ci-credentials-'));
    roots.push(root);
    const suite = join(
      root,
      'dist/.playwright/trinity-e2e-android/run/android.installed-webview',
    );
    const payload = `V Capacitor: callback: 1, pluginId: SecureStorage, methodName: internalSetItem, methodData: {"prefixedKey":"capacitor-storage_matrix.accessToken:@u:localhost","data":"\"${token}\"","sync":false}\n`;
    const files = [
      'host-output/logcat-final.txt',
      'test-output/journey-android-webview/logcat.txt',
      'test-output/journey-android-webview/attachments/logcat-txt-0a1b.txt',
    ];
    for (const file of files) {
      mkdirSync(join(suite, file, '..'), { recursive: true });
      writeFileSync(join(suite, file), payload);
    }
    const result = await protectUploadDiagnostics({
      root,
      reportPath:
        'dist/.playwright/trinity-e2e-android/*/android.installed-webview/**',
    });
    expect(result.withheld).toEqual([]);
    expect(result.redacted).toHaveLength(3);
    for (const file of files) {
      const published = readFileSync(join(suite, file), 'utf8');
      expect(published).not.toContain('syt_');
      expect(published).toContain('methodData: [REDACTED]');
    }
  });

  it('redacts test-account passwords from the installed-webview and native layouts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'trinity-ci-passwords-'));
    roots.push(root);
    const password = 'probe-user-android-webview-w0-r0-0a1b2c3d4e-run-pass';
    const suite = join(
      root,
      'dist/.playwright/trinity-e2e-android/run/android.example',
    );
    const files = {
      // The failing probe's page snapshot: a filled password textbox.
      'test-output/probe/error-context.md': `- textbox "Username": probe-user\n- textbox "Password": ${password}\n- button "Show password"\n`,
      // A request body names the password; the Maestro command does not.
      'test-output/probe/attachments/request-0a1b.json': JSON.stringify({
        identifier: { user: 'probe-user' },
        password,
      }),
      'flow/commands.json': JSON.stringify([
        { command: { inputTextCommand: { text: password } } },
      ]),
      'junit/results.xml': `<system-out>  - fill(&quot;${password}&quot;) in ${roomId}</system-out>\n`,
      'host-output/logcat-final.txt':
        'I Maestro: enabled: true; password: false; scrollable: false\n',
      'report/trace/viewer.js': 'constructor({password:e,rawPassword:t}){}',
    };
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(join(suite, file, '..'), { recursive: true });
      writeFileSync(join(suite, file), content);
    }
    mkdirSync(join(root, 'dist/.ci'), { recursive: true });
    writeFileSync(
      join(root, 'dist/.ci/suite.log'),
      '[suite] stdout: login verify-e2e-pass-123\n',
    );
    const result = await protectUploadDiagnostics({
      root,
      reportPath: 'dist/.playwright/trinity-e2e-android/*/android.example/**',
    });
    expect(result.withheld).toEqual([]);
    for (const file of Object.keys(files))
      expect(readFileSync(join(suite, file), 'utf8')).not.toContain(password);
    expect(
      readFileSync(join(suite, 'test-output/probe/error-context.md'), 'utf8'),
    ).toContain('- textbox "Password": [REDACTED]\n');
    expect(readFileSync(join(suite, 'flow/commands.json'), 'utf8')).toContain(
      '"text":"[REDACTED]"',
    );
    expect(readFileSync(join(suite, 'junit/results.xml'), 'utf8')).toBe(
      '<system-out>  - fill(&quot;[REDACTED]&quot;) in [REDACTED]</system-out>\n',
    );
    expect(
      readFileSync(join(suite, 'host-output/logcat-final.txt'), 'utf8'),
    ).toBe(files['host-output/logcat-final.txt']);
    expect(readFileSync(join(suite, 'report/trace/viewer.js'), 'utf8')).toBe(
      files['report/trace/viewer.js'],
    );
    expect(readFileSync(join(root, 'dist/.ci/suite.log'), 'utf8')).toBe(
      '[suite] stdout: login [REDACTED]\n',
    );
  });
});
