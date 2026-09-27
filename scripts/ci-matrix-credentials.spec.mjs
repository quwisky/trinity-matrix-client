import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { protectReportCredentials } from './ci-matrix-credentials.mjs';
import { isZip, readZip, writeZip } from './zip-archive.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.doUnmock('../e2e/support/matrix-identifiers.mts');
  vi.resetModules();
});

// Synthetic credentials in the shapes the leaked reports carried; none is real.
const token = `syt_${'bGluay11c2Vy'}_${'AbCdEfGhIjKlMnOpQrSt'}_0a1B2c`;
const roomId = '!AbCdEfGhIjKlMnOpQr:localhost';
const login = JSON.stringify({
  user_id: '@link-user-chromium-w0-r0-run:localhost',
  access_token: token,
  home_server: 'localhost',
  device_id: 'ABCDEFGHIJ',
});
const reportPath =
  'dist/.playwright/trinity-e2e-browser/*/browser.canonical/**';

const text = (name, value) => ({ name, data: Buffer.from(value, 'utf8') });
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const wasm = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);

/** A trace as Playwright writes it: network log, resources and frames. */
const trace = () =>
  writeZip([
    text(
      '0-trace.network',
      `${JSON.stringify({
        type: 'resource-snapshot',
        snapshot: {
          request: {
            url: `http://localhost:8008/_matrix/client/v3/sync`,
            headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
          },
        },
      })}\n`,
    ),
    text('resources/0a1b.json', login),
    { name: 'resources/2c3d.jpeg', data: jpeg },
    { name: 'resources/4e5f.wasm', data: wasm },
  ]);

/** A blob report whose step title is a login response, as in the CI leak. */
const blob = () =>
  writeZip([
    text(
      'report.jsonl',
      `${JSON.stringify({ method: 'onStepBegin', params: { step: { title: login } } })}\n`,
    ),
    { name: 'resources/9f8e.zip', data: trace() },
  ]);

function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), 'trinity-ci-credentials-'));
  roots.push(root);
  const suite = join(
    root,
    'dist/.playwright/trinity-e2e-browser/run/browser.canonical',
  );
  for (const [path, content] of Object.entries(files)) {
    const target = path.startsWith('dist/.ci/')
      ? join(root, path)
      : join(suite, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return { root, suite };
}

/** Every text byte of a file, descending into archives and the HTML payload. */
function published(bytes) {
  if (isZip(bytes))
    return readZip(bytes)
      .map(({ data }) => published(data))
      .join('\n');
  const content = bytes.toString('latin1');
  const payload =
    /data:application\/zip;base64,([A-Za-z0-9+/=]*)<\/template>/u.exec(content);
  return payload
    ? `${content}\n${published(Buffer.from(payload[1], 'base64'))}`
    : content;
}

const html = (archive) =>
  `<!DOCTYPE html><html><body><div id='root'></div></body></html>\n<template id="playwrightReportBase64">data:application/zip;base64,${archive.toString('base64')}</template>`;

describe('Browser and desktop upload credential boundary', () => {
  it('redacts credentials from text reports but keeps Matrix identifiers', () => {
    const { root, suite } = workspace({
      'junit/results.xml': `<failure message="login ${login}"/>\n`,
      'test-progress.jsonl': `{"title":"Authorization: Bearer ${token}","room":"${roomId}"}\n`,
      'test-output/a/error-context.md': `- access_token=${token}\n`,
      'dist/.ci/suite.log': `[suite] ${token}\n`,
    });
    const result = protectReportCredentials({ root, reportPath });
    expect(result.withheld).toEqual([]);
    expect(result.redacted).toHaveLength(4);
    expect(readFileSync(join(suite, 'test-progress.jsonl'), 'utf8')).toBe(
      `{"title":"Authorization: Bearer [REDACTED]","room":"${roomId}"}\n`,
    );
    expect(readFileSync(join(root, 'dist/.ci/suite.log'), 'utf8')).toBe(
      '[suite] [REDACTED]\n',
    );
    for (const file of ['junit/results.xml', 'test-output/a/error-context.md'])
      expect(readFileSync(join(suite, file), 'utf8')).not.toContain('syt_');
  });

  it('rewrites the blob report, its traces and a standalone trace', () => {
    const { root, suite } = workspace({
      'blob-report/report-1.zip': blob(),
      'test-output/a/trace.zip': trace(),
    });
    const result = protectReportCredentials({ root, reportPath });
    expect(result.withheld).toEqual([]);
    expect(result.redacted).toHaveLength(2);
    for (const file of [
      'blob-report/report-1.zip',
      'test-output/a/trace.zip',
    ]) {
      const content = published(readFileSync(join(suite, file)));
      expect(content).not.toContain('syt_');
      expect(content).toContain('"access_token":"[REDACTED]"');
      expect(content).toContain('@link-user-chromium-w0-r0-run:localhost');
    }
    const [, nested] = readZip(
      readFileSync(join(suite, 'blob-report/report-1.zip')),
    );
    const members = readZip(nested.data);
    expect(members.map(({ name }) => name)).toEqual([
      '0-trace.network',
      'resources/0a1b.json',
      'resources/2c3d.jpeg',
      'resources/4e5f.wasm',
    ]);
    expect(members[2].data.equals(jpeg)).toBe(true);
    expect(members[3].data.equals(wasm)).toBe(true);
    expect(members[0].data.toString()).toContain('"value":"Bearer [REDACTED]"');
  });

  it('rewrites the HTML report payload and its trace data', () => {
    const { root, suite } = workspace({
      'html-report/index.html': html(
        writeZip([text('report.json', '{}'), text('0a.json', login)]),
      ),
      'html-report/data/9f8e.zip': trace(),
      'html-report/data/1a2b.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]),
    });
    const result = protectReportCredentials({ root, reportPath });
    expect(result.withheld).toEqual([]);
    expect(result.redacted).toHaveLength(2);
    const page = readFileSync(join(suite, 'html-report/index.html'));
    expect(published(page)).not.toContain('syt_');
    expect(published(page)).toContain('"access_token":"[REDACTED]"');
    expect(page.toString()).toContain("<div id='root'></div>");
    expect(existsSync(join(suite, 'html-report/data/1a2b.png'))).toBe(true);
  });

  it('leaves clean reports byte-identical', () => {
    const archive = writeZip([text('report.jsonl', '{"method":"onEnd"}\n')]);
    const { root, suite } = workspace({
      'blob-report/report-1.zip': archive,
      'junit/results.xml': `<testcase name="${roomId}"/>\n`,
    });
    const result = protectReportCredentials({ root, reportPath });
    expect(result).toMatchObject({ files: 2, redacted: [], withheld: [] });
    expect(
      readFileSync(join(suite, 'blob-report/report-1.zip')).equals(archive),
    ).toBe(true);
  });

  it('drops an archive member it cannot verify and reports it', () => {
    const { root, suite } = workspace({
      'blob-report/report-1.zip': writeZip([
        text('report.jsonl', '{}\n'),
        { name: 'resources/opaque.bin', data: Buffer.from([1, 0, 2, 3]) },
      ]),
    });
    const result = protectReportCredentials({ root, reportPath });
    expect(result.withheld).toEqual([
      'dist/.playwright/trinity-e2e-browser/run/browser.canonical/blob-report/report-1.zip!resources/opaque.bin',
    ]);
    expect(
      readZip(readFileSync(join(suite, 'blob-report/report-1.zip'))).map(
        ({ name }) => name,
      ),
    ).toEqual(['report.jsonl']);
  });

  it('withholds a file it cannot verify as text or as an archive', () => {
    const truncated = blob().subarray(0, 200);
    const { root, suite } = workspace({
      'blob-report/report-1.zip': truncated,
      'test-output/a/dump.bin': Buffer.from([1, 0, 2, 3]),
    });
    const result = protectReportCredentials({ root, reportPath });
    expect(result.withheld).toHaveLength(2);
    expect(existsSync(join(suite, 'blob-report/report-1.zip'))).toBe(false);
    expect(existsSync(join(suite, 'test-output/a/dump.bin'))).toBe(false);
  });

  it('withholds every report that still carries a credential after the scrub', async () => {
    // Fail closed: with the redaction disabled, the rescan alone keeps each
    // leaked report, archive member and HTML payload out of the upload.
    vi.doMock('../e2e/support/matrix-identifiers.mts', async (original) => ({
      ...(await original()),
      redactMatrixCredentials: (value) => value,
    }));
    vi.resetModules();
    const { protectReportCredentials: unredacted } =
      await import('./ci-matrix-credentials.mjs');
    const { root, suite } = workspace({
      'junit/results.xml': `<failure message="${login}"/>\n`,
      'blob-report/report-1.zip': blob(),
      'html-report/index.html': html(writeZip([text('0a.json', login)])),
    });
    const result = unredacted({ root, reportPath });
    expect(result.withheld).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/junit\/results\.xml$/u),
        expect.stringMatching(/report-1\.zip!report\.jsonl$/u),
        expect.stringMatching(
          /report-1\.zip!resources\/9f8e\.zip!0-trace\.network$/u,
        ),
        expect.stringMatching(/index\.html!#report!0a\.json$/u),
      ]),
    );
    expect(existsSync(join(suite, 'junit/results.xml'))).toBe(false);
    for (const file of ['blob-report/report-1.zip', 'html-report/index.html'])
      expect(published(readFileSync(join(suite, file)))).not.toContain('syt_');
  });

  describe('test-account passwords', () => {
    // A synthetic per-run password and the harness's fixed one, in every
    // shape Playwright recorded them.
    const password = 'link-user-chromium-w0-r0-0a1b2c3d4e-runl-pass';
    const user = 'link-user-chromium-w0-r0-0a1b2c3d4e-runl';
    const viewerCode = 'constructor({password:e,rawPassword:t}){}';
    const passwordTrace = () =>
      writeZip([
        text(
          '0-trace.network',
          `${JSON.stringify({ snapshot: { request: { postData: { text: JSON.stringify({ identifier: { user }, password }) } } } })}\n`,
        ),
        text(
          '0-trace.trace',
          [
            JSON.stringify({
              type: 'before',
              title: `Fill "${password}" getByLabel('Password')`,
              params: {
                selector: 'internal:label="Password"s',
                value: password,
              },
            }),
            JSON.stringify({ type: 'log', message: `  fill("${password}")` }),
            JSON.stringify({
              type: 'frame-snapshot',
              html: [
                'INPUT',
                { __playwright_value_: password, type: 'password' },
              ],
            }),
            JSON.stringify({
              type: 'frame-snapshot',
              html: ['INPUT', { __playwright_value_: user, type: 'text' }],
            }),
          ].join('\n'),
        ),
        text('resources/viewer.js', viewerCode),
      ]);
    const passwordBlob = () =>
      writeZip([
        text(
          'report.jsonl',
          `${JSON.stringify({ params: { step: { title: `Fill "${password}" getByLabel('Password')` } } })}\n` +
            `${JSON.stringify({ params: { step: { title: `Fill "${user}" getByLabel('Username')`, room: roomId } } })}\n`,
        ),
        { name: 'resources/0a1b.zip', data: passwordTrace() },
      ]);

    it('redacts every recorded password but keeps users and Room ids', () => {
      const { root, suite } = workspace({
        'blob-report/report-1.zip': passwordBlob(),
        'test-output/a/trace.zip': passwordTrace(),
        'html-report/index.html': html(
          writeZip([
            text(
              '0a.json',
              JSON.stringify({
                title: `Fill "${password}" getByLabel('Password')`,
              }),
            ),
          ]),
        ),
        'html-report/trace/sw.bundle.js': viewerCode,
        'junit/results.xml': `<system-out>  - fill(&quot;${password}&quot;) in ${roomId}</system-out>\n`,
        'dist/.ci/suite.log': '[login] verify-e2e with verify-e2e-pass-123\n',
      });
      const result = protectReportCredentials({ root, reportPath });
      expect(result.withheld).toEqual([]);
      const files = [
        'blob-report/report-1.zip',
        'test-output/a/trace.zip',
        'html-report/index.html',
        'junit/results.xml',
      ];
      for (const file of files) {
        const content = published(readFileSync(join(suite, file)));
        expect(content).not.toContain(password);
        expect(content).toContain('[REDACTED]');
      }
      const blobText = published(
        readFileSync(join(suite, 'blob-report/report-1.zip')),
      );
      expect(blobText).toContain(`Fill \\"${user}\\" getByLabel('Username')`);
      expect(blobText).toContain(`"__playwright_value_":"${user}"`);
      expect(blobText).toContain(roomId);
      expect(blobText).toContain(viewerCode);
      expect(readFileSync(join(suite, 'junit/results.xml'), 'utf8')).toBe(
        `<system-out>  - fill(&quot;[REDACTED]&quot;) in ${roomId}</system-out>\n`,
      );
      expect(readFileSync(join(root, 'dist/.ci/suite.log'), 'utf8')).toBe(
        '[login] verify-e2e with [REDACTED]\n',
      );
      expect(
        readFileSync(join(suite, 'html-report/trace/sw.bundle.js'), 'utf8'),
      ).toBe(viewerCode);
    });

    it('redacts a password harvested from one file wherever else it appears', () => {
      const { root, suite } = workspace({
        'test-output/a/trace.zip': passwordTrace(),
        'test-output/a/stdout.txt': `typed ${password} into the form\n`,
      });
      protectReportCredentials({ root, reportPath });
      expect(
        readFileSync(join(suite, 'test-output/a/stdout.txt'), 'utf8'),
      ).toBe('typed [REDACTED] into the form\n');
    });

    it('withholds what still carries a password after the scrub', async () => {
      vi.doMock('../e2e/support/matrix-identifiers.mts', async (original) => ({
        ...(await original()),
        redactAccountPasswords: (value) => value,
      }));
      vi.resetModules();
      const { protectReportCredentials: unredacted } =
        await import('./ci-matrix-credentials.mjs');
      const { root, suite } = workspace({
        'blob-report/report-1.zip': passwordBlob(),
        'dist/.ci/suite.log': 'verify-e2e-pass-123\n',
      });
      const result = unredacted({ root, reportPath });
      expect(result.withheld).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/report-1\.zip!report\.jsonl$/u),
          expect.stringMatching(
            /report-1\.zip!resources\/0a1b\.zip!0-trace\.trace$/u,
          ),
          expect.stringMatching(
            /report-1\.zip!resources\/0a1b\.zip!0-trace\.network$/u,
          ),
          expect.stringMatching(/dist\/\.ci\/suite\.log$/u),
        ]),
      );
      expect(result.withheld.join('\n')).not.toContain(password);
      expect(existsSync(join(root, 'dist/.ci/suite.log'))).toBe(false);
      expect(
        published(readFileSync(join(suite, 'blob-report/report-1.zip'))),
      ).not.toContain(password);
    });
  });

  it('rejects an empty report path', () => {
    expect(() =>
      protectReportCredentials({ root: tmpdir(), reportPath: '' }),
    ).toThrow(/CI_REPORT_PATH/u);
  });
});
