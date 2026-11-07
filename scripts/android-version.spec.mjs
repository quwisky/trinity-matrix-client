import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { androidVersion } from './android-version.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const code = (version) => androidVersion(version).versionCode;

describe('android version', () => {
  it('maps release-please versions to monotonic version codes', () => {
    expect(androidVersion('0.7.0-next.1')).toEqual({
      versionName: '0.7.0-next.1',
      versionCode: 70001,
    });
    // release-please opens every prerelease cycle at -next.0.
    expect(code('0.7.0-next.0')).toBe(70000);
    expect(code('0.7.0')).toBe(70099);
    expect(code('0.8.0-next.3')).toBe(80003);
    expect(code('1.2.3')).toBe(1020399);
    expect(code('2099.99.99')).toBe(2099999999);
  });

  it('orders a prerelease below its stable release and above the previous stable', () => {
    const ordered = [
      '0.6.0',
      '0.7.0-next.0',
      '0.7.0-next.1',
      '0.7.0-next.2',
      '0.7.0',
      '0.7.1-next.0',
      '0.7.1-next.1',
      '0.8.0-next.0',
    ].map(code);
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
    expect(new Set(ordered).size).toBe(ordered.length);
  });

  it('rejects versions it cannot encode', () => {
    for (const version of [
      '1.100.0',
      '1.0.100',
      '0.7.0-next.99',
      '0.7.0-rc.1',
      'v0.7.0',
      'abc',
      '01.2.3',
      '1.02.3',
      '1.2.03',
      '0.7.0-next.01',
      '0.7.0-next.00',
      '21474.0.0',
      '210000.0.0',
    ]) {
      expect(() => androidVersion(version), version).toThrow(version);
    }
  });

  it('is deterministic', () => {
    expect(androidVersion('0.7.0-next.1')).toEqual(
      androidVersion('0.7.0-next.1'),
    );
  });

  it('the CLI prints the package version', () => {
    const pkg = JSON.parse(
      readFileSync(join(scriptsDir, '..', 'package.json'), 'utf8'),
    );
    const out = execFileSync(
      process.execPath,
      [join(scriptsDir, 'android-version.mjs')],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(out)).toEqual(androidVersion(pkg.version));
  });
});
