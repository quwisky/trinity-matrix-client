import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scrub, scrubDirectory } from '../e2e/mobile/support/scrub.mts';

describe('mobile E2E artifact scrub', () => {
  it('removes Matrix ids, tokens and passwords', () => {
    const out = scrub(
      '@alice:localhost !abc:localhost $AbCdEfGhIjKlMnOpQrStUv syt_x_y {"password":"p"}',
    );
    expect(out).toBe(
      '@<user> !<room> $<event> <token> {"password":"<redacted>"}',
    );
  });

  it('redacts text typed into a form field', () => {
    expect(scrub('body: {"text":"smoke-pass-123"}')).toBe(
      'body: {"text":"<typed>"}',
    );
    expect(scrub('{"value":["p","a","s","s"]}')).toBe('{"value":["<typed>"]}');
  });
});

describe('mobile E2E scrub on disk', () => {
  const run = (dir) =>
    execFileSync(
      process.execPath,
      [join(import.meta.dirname, '../e2e/mobile/scrub-cli.mts'), ...dir],
      { stdio: 'pipe' },
    );

  it('scrubs .json and keeps it valid, including host:port ids', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'scrub-'));
    const file = join(tmp, 'state.json');
    writeFileSync(
      file,
      JSON.stringify({ u: '@alice:localhost:8448', password: 'p', n: 1 }),
    );
    scrubDirectory(tmp);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      u: '@<user>',
      password: '<redacted>',
      n: 1,
    });
  });

  it('scrubs a .webview.html DOM capture', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'scrub-'));
    const file = join(tmp, 'x.webview.html');
    writeFileSync(
      file,
      '<a title="@alice:localhost">@alice:localhost</a><i data-t="syt_abc_def"></i>',
    );
    scrubDirectory(tmp);
    expect(readFileSync(file, 'utf8')).toBe(
      '<a title="@<user>">@<user></a><i data-t="<token>"></i>',
    );
  });

  it('redacts escaped JSON forms', () => {
    expect(scrub('{\\"password\\":\\"hunter2\\",\\"text\\":\\"abc\\"}')).toBe(
      '{\\"password\\":\\"<redacted>\\",\\"text\\":\\"<typed>\\"}',
    );
  });

  it('redacts URL-encoded user and room ids, any case', () => {
    expect(scrub('/v3/user/%40smoke-573fd710%3Alocalhost/filter?x=1')).toBe(
      '/v3/user/%40<user>/filter?x=1',
    );
    expect(scrub('/rooms/%21AbC%3ALOCALHOST%3A8448/send')).toBe(
      '/rooms/%21<room>/send',
    );
    expect(scrub('%40a%3alocalhost')).toBe('%40<user>');
  });

  it('CLI scrubs every directory it is given', () => {
    const a = mkdtempSync(join(tmpdir(), 'scrub-a-'));
    const b = mkdtempSync(join(tmpdir(), 'scrub-b-'));
    writeFileSync(join(a, 'x.log'), '@a:localhost');
    writeFileSync(join(b, 'y.txt'), 'syt_abc');
    run([a, b]);
    expect(readFileSync(join(a, 'x.log'), 'utf8')).toBe('@<user>');
    expect(readFileSync(join(b, 'y.txt'), 'utf8')).toBe('<token>');
  });
});
