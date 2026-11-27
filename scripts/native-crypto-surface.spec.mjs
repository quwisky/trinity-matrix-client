import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildSurface,
  contractSources,
  coveredEntries,
  readSurface,
  statusCounts,
  surfaceErrors,
  usedSymbols,
} from './native-crypto-surface.mjs';

describe('native/crypto/surface.json', () => {
  it('lists exactly what the installed matrix-js-sdk uses, and every done entry has a contract case', () => {
    const symbols = usedSymbols();
    // A broken inventory (no js-sdk sources, wrong package path) must not pass as "nothing used".
    expect(symbols).toContain('OlmMachine.decryptRoomEvent');
    expect(symbols.length).toBeGreaterThan(300);
    expect(
      surfaceErrors(readSurface(), symbols, coveredEntries(contractSources())),
    ).toEqual([]);
  });

  it('matches the status table in the developer guide', () => {
    const guide = readFileSync(
      resolve(
        import.meta.dirname,
        '../apps/docs-developers/src/content/docs/platforms/native-crypto.md',
      ),
      'utf8',
    );
    const table = Object.fromEntries(
      [
        ...guide.matchAll(/^\| ([a-z-]+) +\| (\d+) +\| (\d+) +\| (\d+) +\|$/gm),
      ].map(([, area, done, planned, shim]) => [
        area,
        { done: +done, planned: +planned, shim: +shim },
      ]),
    );
    expect(table).toEqual(statusCounts(readSurface()));
  });
});

describe('surfaceErrors', () => {
  const symbols = [
    'OlmMachine',
    'OlmMachine.close',
    'OlmMachine.sign',
    'UserId',
    'UserId.toString',
    'BackupDecryptionKey.toBase64',
  ];
  const surface = () => {
    const built = buildSurface(symbols);
    built.stateful.OlmMachine.close = {
      status: 'done',
      area: 'core',
      native: 'close',
    };
    built.stateful.OlmMachine.sign = { status: 'planned', area: 'backup' };
    return built;
  };
  const covered = new Set(['OlmMachine.close']);

  it('accepts a matching manifest', () => {
    expect(buildSurface(symbols).pureJs).toEqual({ UserId: ['toString'] });
    expect(buildSurface(symbols).wasmHelpers).toEqual({
      BackupDecryptionKey: ['toBase64'],
    });
    expect(surfaceErrors(surface(), symbols, covered)).toEqual([]);
  });

  it('fails on a member js-sdk uses that the manifest lacks, and on one it no longer uses', () => {
    const errors = surfaceErrors(
      surface(),
      [...symbols, 'OlmMachine.getDevice'].filter(
        (symbol) => symbol !== 'OlmMachine.sign',
      ),
      covered,
    );
    expect(errors).toContain(
      'OlmMachine.getDevice: used by matrix-js-sdk, missing',
    );
    expect(errors).toContain(
      'OlmMachine.sign: no longer used by matrix-js-sdk',
    );
    expect(
      surfaceErrors(surface(), [...symbols, 'UserId.free'], covered),
    ).toContain("pureJs: differs from matrix-js-sdk's use; run write");
  });

  it('fails on a done entry without a contract case or a native call', () => {
    const manifest = surface();
    manifest.stateful.OlmMachine.sign = { status: 'done', area: 'backup' };
    expect(surfaceErrors(manifest, symbols, covered)).toEqual([
      'OlmMachine.sign: done without a native call',
      'OlmMachine.sign: done without a contract-test case',
    ]);
    expect(
      surfaceErrors(surface(), symbols, new Set([...covered, 'Sas.confirm'])),
    ).toEqual(['Sas.confirm: covered by a contract case, not in the manifest']);
  });

  it('gives new entries planned with no area until one is assigned', () => {
    const built = buildSurface([...symbols, 'OlmMachine.getDevice']);
    expect(built.stateful.OlmMachine.getDevice).toEqual({
      status: 'planned',
      area: 'unassigned',
    });
    expect(
      surfaceErrors(built, [...symbols, 'OlmMachine.getDevice'], new Set()),
    ).toContain('OlmMachine.getDevice: no area');
  });

  it('reads covered entries from covered([...]) calls', () => {
    expect([
      ...coveredEntries([
        "covered(['OlmMachine.sign', 'OlmMachine.verifyBackup'], 'x', fn)",
        "covered(\n  ['BackupKeys.backupVersion'],\n)",
      ]),
    ]).toEqual([
      'OlmMachine.sign',
      'OlmMachine.verifyBackup',
      'BackupKeys.backupVersion',
    ]);
  });
});
