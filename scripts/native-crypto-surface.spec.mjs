import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  appSources,
  buildSurface,
  contractSourceErrors,
  contractSources,
  coveredEntries,
  legacyMigrationUses,
  readSurface,
  shimObligations,
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
    expect(contractSourceErrors(contractSources())).toEqual([]);
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

  it("names every shim obligation in the guide's milestone 3 list", () => {
    const guide = readFileSync(
      resolve(
        import.meta.dirname,
        '../apps/docs-developers/src/content/docs/platforms/native-crypto.md',
      ),
      'utf8',
    );
    const section = guide
      .split('## What milestone 3 needs')[1]
      ?.split('\n## ')[0];
    expect(section).toBeDefined();
    const obligations = shimObligations(readSurface());
    expect(obligations).toContain('CollectStrategy.deviceBasedStrategy');
    expect(obligations).toContain('OlmMachine.receiveSyncChanges');
    expect(
      obligations.filter((name) => !section.includes(`\`${name}\``)),
    ).toEqual([]);
  });
});

describe('shimObligations', () => {
  it('lists shim notes and members whose note says the shim must act', () => {
    expect(
      shimObligations({
        shimNotes: { 'UserId.toString': 'x' },
        stateful: {
          OlmMachine: {
            sign: { note: 'the shim must sign' },
            close: { note: 'nothing to do' },
          },
        },
      }),
    ).toEqual(['UserId.toString', 'OlmMachine.sign']);
  });
});

describe('legacy crypto migration', () => {
  // The crate does not port matrix-js-sdk's libolm migration (`Migration.*` are shim entries
  // that throw): it must stay unreachable from the app.
  it('is never set up by the app', () => {
    const sources = appSources();
    expect(
      Object.keys(sources).some((path) =>
        path.endsWith('matrix-client.service.ts'),
      ),
    ).toBe(true);
    expect(legacyMigrationUses(sources)).toEqual([]);
  });

  it("relies on matrix-js-sdk's default legacy store being an empty memory store", () => {
    const sdk = resolve(
      import.meta.dirname,
      '../node_modules/matrix-js-sdk/src',
    );
    expect(readFileSync(join(sdk, 'matrix.ts'), 'utf8')).toContain(
      'let cryptoStoreFactory = (): CryptoStore => new MemoryCryptoStore();',
    );
    const memory = readFileSync(
      join(sdk, 'crypto/store/memory-crypto-store.ts'),
      'utf8',
    );
    expect(memory).toContain('return this.account !== null;');
    expect(memory).toMatch(/private account: string \| null = null;/);
    expect(
      readFileSync(join(sdk, 'rust-crypto/libolm_migration.ts'), 'utf8'),
    ).toContain('if (!(await legacyStore.containsData())) {');
  });

  it('finds each way of passing a legacy store, outside comments', () => {
    expect(
      legacyMigrationUses({
        'a.ts':
          'createClient({ baseUrl, cryptoStore: new IndexedDBCryptoStore(idb, "x") });',
        'b.ts':
          'setCryptoStoreFactory(() => store);\nconst opts = { pickleKey: key };',
        'c.ts':
          '// cryptoStore: no\n/* pickleKey: no */\nconst hasCryptoStore = "cryptoStore";',
        'd.ts': 'createClient({ baseUrl, cryptoStore, pickleKey });',
        'e.ts': 'opts["cryptoStore"] = s;\nopts.legacyPickleKey = k;',
      }),
    ).toEqual([
      'a.ts: property cryptoStore',
      'a.ts: name IndexedDBCryptoStore',
      'b.ts: name setCryptoStoreFactory',
      'b.ts: property pickleKey',
      'd.ts: property cryptoStore',
      'd.ts: property pickleKey',
      'e.ts: member cryptoStore',
      'e.ts: member legacyPickleKey',
    ]);
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
    built.stateful.OlmMachine.sign = {
      status: 'shim',
      area: 'backup',
      note: 'kept in JS',
    };
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

  it('keeps shim notes on pure JS and helper members and rejects notes on anything else', () => {
    const manifest = surface();
    manifest.shimNotes = { 'UserId.toString': 'kept in JS' };
    expect(buildSurface(symbols, manifest).shimNotes).toEqual({
      'UserId.toString': 'kept in JS',
    });
    expect(surfaceErrors(manifest, symbols, covered)).toEqual([]);
    manifest.shimNotes['UserId.free'] = 'gone';
    manifest.shimNotes['UserId.toBase64'] = '';
    expect(surfaceErrors(manifest, symbols, covered)).toEqual([
      'shimNotes: UserId.free is not a pureJs or wasmHelpers member',
      'shimNotes: UserId.toBase64 is not a pureJs or wasmHelpers member',
    ]);
  });

  it('fails on a planned entry unless it is allowed', () => {
    const manifest = surface();
    manifest.stateful.OlmMachine.sign = { status: 'planned', area: 'backup' };
    expect(surfaceErrors(manifest, symbols, covered)).toEqual([
      'OlmMachine.sign: planned, and not in ALLOWED_PLANNED',
    ]);
    expect(
      surfaceErrors(manifest, symbols, covered, new Set(['OlmMachine.sign'])),
    ).toEqual([]);
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

  it('fails on an owner that is in none of the lists', () => {
    expect(
      surfaceErrors(surface(), [...symbols, 'Mystery.thing'], covered),
    ).toContain(
      'Mystery: not classified; add it to STATEFUL, WASM_HELPERS or PURE_JS in scripts/native-crypto-surface.mjs',
    );
    expect(buildSurface([...symbols, 'Mystery.thing']).pureJs).toEqual({
      UserId: ['toString'],
    });
  });

  it('ignores covered([...]) in comments and rejects skipped or focused cases', () => {
    expect([
      ...coveredEntries([
        "// covered(['A.b'], 'x', fn)\n/* covered(['C.d']) */\ncovered(['E.f'], 'y', fn)",
      ]),
    ]).toEqual(['E.f']);
    expect(
      contractSourceErrors([
        "describe.skipIf(!hasCargo)('x', () => {})",
        "it.skip('x')",
        "describe.skipIf(other)('x')",
        "it.only('x')",
      ]),
    ).toEqual([
      'contract tests may not skip or focus cases: it.skip(',
      'contract tests may not skip or focus cases: describe.skipIf(other)',
      'contract tests may not skip or focus cases: it.only(',
    ]);
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

describe('usedSymbols', () => {
  let root;
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('finds members reached through destructuring', () => {
    root = mkdtempSync(join(tmpdir(), 'native-crypto-surface-'));
    const write = (path, text) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    const wasmPackage = 'node_modules/@matrix-org/matrix-sdk-crypto-wasm';
    write(
      `${wasmPackage}/package.json`,
      '{ "name": "@matrix-org/matrix-sdk-crypto-wasm", "types": "index.d.ts" }',
    );
    write(
      `${wasmPackage}/index.d.ts`,
      'export declare class Thing { channel: string; message: string; other: number; unused: number; }\nexport declare function make(): Thing;\n',
    );
    write(
      'node_modules/matrix-js-sdk/src/a.ts',
      [
        'import { make, type Thing } from "@matrix-org/matrix-sdk-crypto-wasm";',
        'const { channel, message: renamed } = make();',
        'export const read = ({ other }: Thing) => other;',
        'export const both = [channel, renamed];',
      ].join('\n'),
    );
    expect(usedSymbols(join(root, 'node_modules/matrix-js-sdk'))).toEqual([
      'Thing',
      'Thing.channel',
      'Thing.message',
      'Thing.other',
      'make',
    ]);
  });

  it('credits each member of a union a generic is constrained to', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'native-crypto-surface-'));
    const write = (path, text) => {
      mkdirSync(dirname(join(fixture, path)), { recursive: true });
      writeFileSync(join(fixture, path), text);
    };
    try {
      const wasmPackage = 'node_modules/@matrix-org/matrix-sdk-crypto-wasm';
      write(
        `${wasmPackage}/package.json`,
        '{ "name": "@matrix-org/matrix-sdk-crypto-wasm", "types": "index.d.ts" }',
      );
      write(
        `${wasmPackage}/index.d.ts`,
        [
          'export declare class Sas { cancel(): void; isDone(): boolean; emoji(): string; }',
          'export declare class Qr { cancel(): void; isDone(): boolean; state(): number; }',
        ].join('\n'),
      );
      write(
        'node_modules/matrix-js-sdk/src/a.ts',
        [
          'import { type Qr, type Sas } from "@matrix-org/matrix-sdk-crypto-wasm";',
          'export class Base<Inner extends Qr | Sas> {',
          '  constructor(protected inner: Inner) {}',
          '  stop(): boolean { this.inner.cancel(); return this.inner.isDone(); }',
          '}',
          'export const shown = (sas: Sas) => sas.emoji();',
        ].join('\n'),
      );
      expect(usedSymbols(join(fixture, 'node_modules/matrix-js-sdk'))).toEqual([
        'Qr',
        'Qr.cancel',
        'Qr.isDone',
        'Sas',
        'Sas.cancel',
        'Sas.emoji',
        'Sas.isDone',
      ]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
