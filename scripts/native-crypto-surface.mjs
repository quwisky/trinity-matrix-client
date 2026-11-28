#!/usr/bin/env node
// native/crypto/surface.json lists what matrix-js-sdk uses of the WASM crypto package, and
// for each stateful member whether the native crate answers it. The "used" lists come from
// the installed (patched) matrix-js-sdk through the TypeScript checker: every symbol whose
// declaration is in the WASM package's .d.ts, or in a `declare module` augmentation of it.
//
//   node scripts/native-crypto-surface.mjs write   # regenerate; keeps status/area/native
//   node scripts/native-crypto-surface.mjs check   # what scripts/native-crypto-surface.spec.mjs runs
import {
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { format, resolveConfig } from 'prettier';
import ts from 'typescript';

const WASM = '@matrix-org/matrix-sdk-crypto-wasm';
const root = resolve(import.meta.dirname, '..');
export const SURFACE_PATH = resolve(root, 'native/crypto/surface.json');

/** Backed by the machine or its store: each member needs a native call (or the shim). */
export const STATEFUL = {
  OlmMachine: 'machine',
  StoreHandle: 'store',
  BackupKeys: 'backup',
  Device: 'devices-identities',
  UserDevices: 'devices-identities',
  OwnUserIdentity: 'devices-identities',
  OtherUserIdentity: 'devices-identities',
  VerificationRequest: 'verification',
  Sas: 'verification',
  Qr: 'verification',
  DehydratedDevices: 'dehydrated-devices',
  DehydratedDevice: 'dehydrated-devices',
  RehydratedDevice: 'dehydrated-devices',
  Migration: 'libolm-migration',
};

/** Stateless crypto helpers that keep running on WASM (research Part 2, A1 and A6). */
export const WASM_HELPERS = new Set([
  'BackupDecryptionKey',
  'MegolmV1BackupKey',
  'DehydratedDeviceKey',
  'SecretsBundle',
  'QrCodeData',
  'QrCodeScan',
  // The MSC4108 QR-login channel; the creation results carry an `EstablishedEcies`.
  'Ecies',
  'EstablishedEcies',
  'InboundCreationResult',
  'OutboundCreationResult',
  'CheckCode',
]);

/** Value types, enums and free functions the shim implements in JavaScript. */
export const PURE_JS = new Set([
  'BaseMigrationData',
  'CancelInfo',
  'CollectStrategy',
  'CrossSigningBootstrapRequests',
  'CrossSigningKeyExport',
  'CrossSigningStatus',
  'Curve25519PublicKey',
  'DecryptedRoomEvent',
  'DecryptedToDeviceEvent',
  'DecryptionErrorCode',
  'DecryptionSettings',
  'DeviceId',
  'DeviceKey',
  'DeviceKeyId',
  'DeviceLists',
  'Ed25519PublicKey',
  'Emoji',
  'EncryptedAttachment',
  'EncryptionAlgorithm',
  'EncryptionInfo',
  'EncryptionSettings',
  'EventId',
  'getVersions',
  'HistoryVisibility',
  'IdentityKeys',
  'initAsync',
  'InvalidToDeviceEvent',
  'KeysBackupRequest',
  'KeysClaimRequest',
  'KeysQueryRequest',
  'KeysUploadRequest',
  'LocalTrust',
  'MaybeSignature',
  'MegolmDecryptionError',
  'OutgoingRequest',
  'PickledInboundGroupSession',
  'PickledSession',
  'PlainTextToDeviceEvent',
  'ProcessedToDeviceEventType',
  'PutDehydratedDeviceRequest',
  'QrCodeIntent',
  'QrState',
  'RoomId',
  'RoomKeyCounts',
  'RoomKeyInfo',
  'RoomKeyWithheldInfo',
  'RoomMessageRequest',
  'RoomPendingKeyBundleDetails',
  'RoomSettings',
  'ShieldColor',
  'ShieldState',
  'ShieldStateCode',
  'Signature',
  'Signatures',
  'SignatureUploadRequest',
  'SignatureVerification',
  'StoredRoomKeyBundleData',
  'ToDeviceEncryptionInfo',
  'ToDeviceRequest',
  'TrustRequirement',
  'UploadSigningKeysRequest',
  'UTDToDeviceEvent',
  'UserId',
  'VerificationMethod',
  'VerificationRequestPhase',
  'Versions',
]);

const ownerOf = (symbol) => symbol.split('.')[0];

/** Owners of `symbols` that are in none of the lists above. */
export const unclassified = (symbols) => [
  ...new Set(
    symbols
      .map(ownerOf)
      .filter(
        (owner) =>
          !(owner in STATEFUL) &&
          !WASM_HELPERS.has(owner) &&
          !PURE_JS.has(owner),
      ),
  ),
];

export const STATUSES = new Set(['done', 'planned', 'shim']);

/**
 * Entries that may be `planned`. Milestone 2 left none: a member js-sdk starts using (which
 * `write` adds as planned) or an entry set back to planned fails the check until it is done,
 * made a shim, or listed here.
 */
export const ALLOWED_PLANNED = new Set([]);

const tsFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.d.ts') ? [path] : [];
  });

const isWasmModule = (node) =>
  ts.isModuleDeclaration(node) &&
  ts.isStringLiteral(node.name) &&
  node.name.text === WASM;

/**
 * Every WASM symbol a matrix-js-sdk's `src/` uses (by default the installed one): `Class`,
 * `Class.member` or a free function, sorted.
 */
export const usedSymbols = (
  jsSdkPath = resolve(root, 'node_modules/matrix-js-sdk'),
) => {
  const jsSdk = realpathSync(jsSdkPath);
  // pnpm links a package's dependencies next to it.
  const wasmDir = realpathSync(join(dirname(jsSdk), WASM));
  const src = join(jsSdk, 'src');
  const program = ts.createProgram(tsFiles(src), {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  });
  const checker = program.getTypeChecker();
  const fromWasm = (declaration) => {
    if (declaration.getSourceFile().fileName.startsWith(wasmDir)) return true;
    for (let node = declaration.parent; node; node = node.parent) {
      if (isWasmModule(node)) return true;
    }
    return false;
  };
  const owner = ({ parent }) =>
    parent &&
    (ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isEnumDeclaration(parent)) &&
    parent.name
      ? parent.name.text
      : '';
  const used = new Set();
  const record = (symbol) => {
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    const declaration = symbol?.declarations?.find(fromWasm);
    if (declaration && !ts.isSourceFile(declaration)) {
      const parent = owner(declaration);
      used.add(parent ? `${parent}.${symbol.name}` : symbol.name);
    }
  };
  for (const file of program.getSourceFiles()) {
    if (!file.fileName.startsWith(src) || file.isDeclarationFile) continue;
    ts.forEachChild(file, function visit(node) {
      const target = ts.isPropertyAccessExpression(node)
        ? node.name
        : ts.isIdentifier(node) &&
            !(
              ts.isPropertyAccessExpression(node.parent) &&
              node.parent.name === node
            )
          ? node
          : undefined;
      if (target) record(checker.getSymbolAtLocation(target));
      // On a value of a union type (such as a generic constrained to `Qr | Sas`), the checker
      // names one member's declaration; the access reaches every member of the union.
      if (ts.isPropertyAccessExpression(node)) {
        const type = checker.getNonNullableType(
          checker.getTypeAtLocation(node.expression),
        );
        for (const member of type.isUnion() ? type.types : []) {
          record(member.getProperty(node.name.text));
        }
      }
      // `const { a, b: c } = value` and destructured parameters name members without an access.
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName ?? node.name;
        if (ts.isIdentifier(key) || ts.isStringLiteral(key)) {
          const type = checker.getNonNullableType(
            checker.getTypeAtLocation(node.parent),
          );
          record(type.getProperty(key.text));
        }
      }
      ts.forEachChild(node, visit);
    });
  }
  return [...used].sort();
};

const sortKeys = (object) =>
  Object.fromEntries(
    Object.entries(object).sort(([a], [b]) => a.localeCompare(b)),
  );

/** Groups the used symbols into the manifest, keeping hand-written fields of `previous`. */
export const buildSurface = (symbols, previous = {}) => {
  const stateful = {};
  const wasmHelpers = {};
  const pureJs = {};
  for (const symbol of symbols) {
    const [owner, member] = symbol.includes('.')
      ? symbol.split('.')
      : [symbol, undefined];
    const group =
      owner in STATEFUL
        ? stateful
        : WASM_HELPERS.has(owner)
          ? wasmHelpers
          : PURE_JS.has(owner)
            ? pureJs
            : undefined;
    // `unclassified` reports it; filing it anywhere would hide that.
    if (!group) continue;
    group[owner] ??= group === stateful ? {} : [];
    if (member === undefined) continue;
    if (group === stateful) {
      group[owner][member] = previous.stateful?.[owner]?.[member] ?? {
        status: 'planned',
        area: STATEFUL[owner] === 'machine' ? 'unassigned' : STATEFUL[owner],
      };
    } else {
      group[owner].push(member);
    }
  }
  return {
    $comment:
      'Generated by scripts/native-crypto-surface.mjs from the installed matrix-js-sdk; edit only status, area, native, event and note, and shimNotes (what the shim must do for a pureJs or wasmHelpers member). See native/crypto/README.md.',
    stateful: sortKeys(
      Object.fromEntries(
        Object.entries(stateful).map(([owner, members]) => [
          owner,
          sortKeys(members),
        ]),
      ),
    ),
    wasmHelpers: sortKeys(wasmHelpers),
    pureJs: sortKeys(pureJs),
    shimNotes: sortKeys(previous.shimNotes ?? {}),
  };
};

const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The `covered([...])` entries of the contract tests, statically, outside comments. */
export const coveredEntries = (sources) =>
  new Set(
    sources.flatMap((source) =>
      [
        ...withoutComments(source).matchAll(/covered\(\s*\[([^\]]*)\]/g),
      ].flatMap(([, list]) =>
        [...list.matchAll(/'([^']+)'/g)].map(([, entry]) => entry),
      ),
    ),
  );

/**
 * A skipped or focused case would still count as covered, so the contract tests have none;
 * only the cargo gate `describe.skipIf(!hasCargo)` is allowed.
 */
export const contractSourceErrors = (sources) =>
  sources.flatMap((source) =>
    [
      ...withoutComments(source).matchAll(
        /\b(?:it|test|describe)\.(?:skip|only|todo)\(|\b(?:it|test|describe)\.(?:skipIf|runIf)\((?!!hasCargo\))[^)]*\)/g,
      ),
    ].map(([found]) => `contract tests may not skip or focus cases: ${found}`),
  );

export const contractSources = () =>
  readdirSync(resolve(root, 'scripts'))
    .filter((name) => /^native-crypto-.*\.test\.mjs$/.test(name))
    .map((name) => readFileSync(resolve(root, 'scripts', name), 'utf8'));

/** Every problem with `surface` against the generated lists and the contract tests. */
export const surfaceErrors = (
  surface,
  symbols,
  covered,
  allowedPlanned = ALLOWED_PLANNED,
) => {
  const errors = unclassified(symbols).map(
    (owner) =>
      `${owner}: not classified; add it to STATEFUL, WASM_HELPERS or PURE_JS in scripts/native-crypto-surface.mjs`,
  );
  const expected = buildSurface(symbols, surface);
  const entries = (manifest) =>
    Object.entries(manifest.stateful ?? {}).flatMap(([owner, members]) =>
      Object.keys(members).map((member) => `${owner}.${member}`),
    );
  const listed = new Set(entries(surface));
  const wanted = new Set(entries(expected));
  for (const entry of wanted) {
    if (!listed.has(entry))
      errors.push(`${entry}: used by matrix-js-sdk, missing`);
  }
  for (const entry of listed) {
    if (!wanted.has(entry))
      errors.push(`${entry}: no longer used by matrix-js-sdk`);
  }
  for (const group of ['wasmHelpers', 'pureJs']) {
    if (JSON.stringify(surface[group]) !== JSON.stringify(expected[group])) {
      errors.push(`${group}: differs from matrix-js-sdk's use; run write`);
    }
  }
  for (const name of Object.keys(surface.shimNotes ?? {})) {
    const [owner, member] = name.split('.');
    const inGroup = (group) => expected[group][owner]?.includes(member);
    if (!inGroup('pureJs') && !inGroup('wasmHelpers'))
      errors.push(`shimNotes: ${name} is not a pureJs or wasmHelpers member`);
  }
  for (const [owner, members] of Object.entries(surface.stateful ?? {})) {
    for (const [member, entry] of Object.entries(members)) {
      const name = `${owner}.${member}`;
      if (!STATUSES.has(entry.status))
        errors.push(`${name}: status ${entry.status}`);
      if (!entry.area || entry.area === 'unassigned')
        errors.push(`${name}: no area`);
      if (entry.status === 'done' && !entry.native)
        errors.push(`${name}: done without a native call`);
      if (entry.status === 'done' && !covered.has(name))
        errors.push(`${name}: done without a contract-test case`);
      if (entry.status === 'shim' && !entry.note)
        errors.push(`${name}: shim without a note`);
      if (entry.status === 'planned' && !allowedPlanned.has(name))
        errors.push(`${name}: planned, and not in ALLOWED_PLANNED`);
    }
  }
  for (const name of covered) {
    const [owner, member] = name.split('.');
    if (!surface.stateful?.[owner]?.[member])
      errors.push(`${name}: covered by a contract case, not in the manifest`);
  }
  return errors;
};

/** Counts by status per area, for the developer guide's table. */
export const statusCounts = (surface) => {
  const counts = {};
  for (const members of Object.values(surface.stateful)) {
    for (const { area, status } of Object.values(members)) {
      counts[area] ??= { done: 0, planned: 0, shim: 0 };
      counts[area][status] += 1;
    }
  }
  return counts;
};

export const readSurface = () => JSON.parse(readFileSync(SURFACE_PATH, 'utf8'));

/**
 * What would make matrix-js-sdk migrate a legacy (libolm) crypto store, which the native
 * crate does not port (the `Migration` entries): a legacy store or pickle key passed to
 * `createClient`, or a store factory set for it. js-sdk migrates only from a store that holds
 * data, and its default is an empty `MemoryCryptoStore`.
 */
const LEGACY_MIGRATION =
  /\b(?:cryptoStore|pickleKey|legacyCryptoStore|legacyPickleKey)\s*:|\bsetCryptoStoreFactory\b|\b(?:IndexedDBCryptoStore|LocalStorageCryptoStore)\b/g;

/** `file: match` for each legacy-migration option in `sources` (path → text), outside comments. */
export const legacyMigrationUses = (sources) =>
  Object.entries(sources).flatMap(([path, source]) =>
    [...withoutComments(source).matchAll(LEGACY_MIGRATION)].map(
      ([found]) => `${path}: ${found}`,
    ),
  );

const sourceFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return ['node_modules', 'dist', 'build', '.angular'].includes(entry.name)
        ? []
        : sourceFiles(path);
    }
    return /\.(?:ts|mts|js|mjs)$/.test(entry.name) &&
      !/\.(?:spec|test)\.[mc]?[jt]s$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
      ? [path]
      : [];
  });

/** The app's own sources (not tests): `libs`, `apps` and `electron`. */
export const appSources = () =>
  Object.fromEntries(
    ['libs', 'apps', 'electron'].flatMap((dir) =>
      sourceFiles(resolve(root, dir)).map((path) => [
        relative(root, path),
        readFileSync(path, 'utf8'),
      ]),
    ),
  );

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command] = process.argv.slice(2);
  const symbols = usedSymbols();
  if (command === 'write' && unclassified(symbols).length) {
    console.error(
      `not classified: ${unclassified(symbols).join(', ')}; add each to STATEFUL, WASM_HELPERS or PURE_JS first`,
    );
    process.exitCode = 1;
  } else if (command === 'write') {
    let previous = {};
    try {
      previous = readSurface();
    } catch {
      // First run: everything starts planned.
    }
    // Written as Prettier writes it, so `pnpm format:check` accepts the file.
    writeFileSync(
      SURFACE_PATH,
      await format(JSON.stringify(buildSurface(symbols, previous)), {
        ...(await resolveConfig(SURFACE_PATH)),
        filepath: SURFACE_PATH,
      }),
    );
    console.log(`wrote ${relative(root, SURFACE_PATH)}`);
  } else if (command === 'check') {
    const errors = [
      ...surfaceErrors(
        readSurface(),
        symbols,
        coveredEntries(contractSources()),
      ),
      ...contractSourceErrors(contractSources()),
    ];
    for (const error of errors) console.error(error);
    if (errors.length) process.exitCode = 1;
    else console.log(JSON.stringify(statusCounts(readSurface()), null, 2));
  } else {
    console.error('usage: native-crypto-surface.mjs write|check');
    process.exitCode = 2;
  }
}
