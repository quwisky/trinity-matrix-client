import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The iOS notification extension only reads: an `event_id_only` push, one event fetched with the
// account's token, no decryption, no /sync, no keys, no to-device. It shares no crypto or sync
// state with the app, so none can be corrupted. See docs-internal/maintenance/push-notifications.md.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extension = join(root, 'ios/App/NotificationService');
const packageRoot = join(root, 'libs/native/capacitor-push/ios/TrinityPush');
const library = join(packageRoot, 'Sources/TrinityPush');

const swiftIn = (directory) =>
  readdirSync(directory, { recursive: true })
    .filter((name) => name.endsWith('.swift'))
    .map((name) => join(directory, name));

const files = [...swiftIn(extension), ...swiftIn(library)];

const allowedImports = new Set([
  'Foundation',
  'Security',
  'CryptoKit',
  'UserNotifications',
  'TrinityPush',
]);

/** The one Matrix path prefix the extension builds on: the event, member and name reads. */
const allowedMatrixPath = '/_matrix/client/v3/rooms/';

/** Path segments of the endpoints that move crypto, sync or to-device state. */
const forbiddenSegments = new Set([
  'sync',
  'keys',
  'room_keys',
  'sendtodevice',
]);

/** What in one Swift source crosses the boundary. */
function sourceViolations(source) {
  const found = [];
  for (const [, module] of source.matchAll(
    /^[ \t]*(?:@\w+[ \t]+)*(?:(?:public|package|internal|fileprivate|private)[ \t]+)?import[ \t]+(?:(?:struct|class|enum|protocol|func|var|let|typealias)[ \t]+)?([\w.]+)/gm,
  )) {
    if (!allowedImports.has(module)) found.push(`import ${module}`);
  }
  for (const [literal] of source.matchAll(/"(?:[^"\\\n]|\\.)*"/g)) {
    const text = literal.slice(1, -1);
    if (text.includes('_matrix') && !text.startsWith(allowedMatrixPath)) {
      found.push(`path ${text}`);
    }
    const segment = text
      .split(/[/?]/)
      .find((part) => forbiddenSegments.has(part.toLowerCase()));
    if (segment) found.push(`segment ${segment}`);
  }
  if (/sendToDevice/i.test(source)) found.push('sendToDevice');
  return found;
}

/** What in TrinityPush's manifest could bring in code beyond its own sources. */
function manifestViolations(manifest) {
  const found = [];
  for (const [name, pattern] of [
    ['.package(', /\.package\(/],
    ['.binaryTarget(', /\.binaryTarget\(/],
    ['.systemLibrary(', /\.systemLibrary\(/],
    ['linkerSettings', /linkerSettings/],
    ['unsafeFlags', /unsafeFlags/],
  ]) {
    if (pattern.test(manifest)) found.push(name);
  }
  if (!/\.target\(name: "TrinityPush"\)/.test(manifest)) {
    found.push('TrinityPush target with dependencies or settings');
  }
  return found;
}

/** One object of the Xcode project by its id, as text. */
function projectObject(project, id) {
  const start = project.indexOf(`\n\t\t${id} `);
  return start < 0
    ? ''
    : project.slice(start, project.indexOf('\n\t\t};', start));
}

const listed = (block, key) =>
  [
    ...(new RegExp(`${key} = \\(([^)]*)\\)`).exec(block)?.[1] ?? '').matchAll(
      /(\w+) \/\* (.+?) \*\//g,
    ),
  ].map(([, id, name]) => ({ id, name }));

/**
 * What the extension target links or compiles beyond TrinityPush and its own folder.
 * `ownSources` are the file names in ios/App/NotificationService.
 */
function projectViolations(project, ownSources) {
  const start = project.indexOf(
    '/* NotificationService */ = {\n\t\t\tisa = PBXNativeTarget;',
  );
  const target = project.slice(start, project.indexOf('\n\t\t};', start));
  if (start < 0) return ['no NotificationService target'];
  const found = [];
  const products = listed(target, 'packageProductDependencies').map(
    (entry) => entry.name,
  );
  if (products.join() !== 'TrinityPush') found.push(`packages ${products}`);
  for (const phase of listed(target, 'buildPhases')) {
    const entries = listed(projectObject(project, phase.id), 'files').map(
      (entry) => entry.name,
    );
    if (
      phase.name === 'Frameworks' &&
      entries.join() !== 'TrinityPush in Frameworks'
    ) {
      found.push(`frameworks ${entries}`);
    }
    if (phase.name === 'Sources') {
      for (const entry of entries) {
        const file = entry.replace(/ in Sources$/, '');
        if (!ownSources.includes(file)) found.push(`source ${file}`);
      }
    }
  }
  return found;
}

const projectFile = join(root, 'ios/App/App.xcodeproj/project.pbxproj');
const ownSources = swiftIn(extension).map((file) => file.split('/').pop());

describe('notification extension boundary', () => {
  it('found the extension and its library, so an empty glob cannot pass', () => {
    const names = files.map((f) => f.split('/').pop());
    expect(names).toContain('NotificationService.swift');
    expect(names).toContain('MatrixPushAPI.swift');
  });

  it.each(files)(
    '%s imports no crypto and reaches no sync, keys or to-device endpoint',
    (file) => {
      expect(sourceViolations(readFileSync(file, 'utf8'))).toEqual([]);
    },
  );

  it('links and compiles only TrinityPush and its own sources into the extension', () => {
    expect(
      projectViolations(readFileSync(projectFile, 'utf8'), ownSources),
    ).toEqual([]);
  });

  it('gives TrinityPush no dependency, binary or linker setting', () => {
    expect(
      manifestViolations(
        readFileSync(join(packageRoot, 'Package.swift'), 'utf8'),
      ),
    ).toEqual([]);
  });

  it.each([
    ['let url = base + "/_matrix/client/v3/sync?timeout=0"', 'segment sync'],
    ['url.appendingPathComponent("sync")', 'segment sync'],
    ['let path = "/_matrix/client/v3/keys/query"', 'segment keys'],
    ['let path = base + "/room_keys/version"', 'segment room_keys'],
    [
      'let path = "/_matrix/client/v3/user/" + id',
      'path /_matrix/client/v3/user/',
    ],
    ['client.sendToDevice(type, payload)', 'sendToDevice'],
    ['import MatrixRustSDK', 'import MatrixRustSDK'],
    ['internal import MatrixRustSDK', 'import MatrixRustSDK'],
    ['public import MatrixRustSDK', 'import MatrixRustSDK'],
    ['@preconcurrency import MatrixRustSDK', 'import MatrixRustSDK'],
    ['@_exported import MatrixRustSDK', 'import MatrixRustSDK'],
  ])('flags the planted source %s', (planted, expected) => {
    expect(
      sourceViolations(`import Foundation
${planted}
`),
    ).toContain(expected);
  });

  it('flags a planted package dependency, binary target or linker setting', () => {
    const manifest = readFileSync(join(packageRoot, 'Package.swift'), 'utf8');
    const planted = (from, to) =>
      manifestViolations(manifest.replace(from, to));
    expect(
      planted(
        '.target(name: "TrinityPush")',
        '.target(name: "TrinityPush", dependencies: ["Olm"]),\n.target(name: "Olm")',
      ),
    ).toEqual(['TrinityPush target with dependencies or settings']);
    expect(
      planted(
        '.target(name: "TrinityPush"),',
        '.target(name: "TrinityPush"),\n.binaryTarget(name: "Crypto", path: "Crypto.xcframework"),',
      ),
    ).toEqual(['.binaryTarget(']);
    expect(
      planted(
        '.target(name: "TrinityPush")',
        '.target(name: "TrinityPush", linkerSettings: [.linkedFramework("X")])',
      ),
    ).toEqual([
      'linkerSettings',
      'TrinityPush target with dependencies or settings',
    ]);
  });

  it('flags a planted framework or app source in the extension target', () => {
    const project = readFileSync(projectFile, 'utf8');
    const framework = project.replace(
      '\t\t\t\tC0FFEE00000000000000B014 /* TrinityPush in Frameworks */,\n',
      '\t\t\t\tC0FFEE00000000000000B014 /* TrinityPush in Frameworks */,\n\t\t\t\tAAAA /* MatrixRustSDK.xcframework in Frameworks */,\n',
    );
    expect(projectViolations(framework, ownSources)).toEqual([
      'frameworks TrinityPush in Frameworks,MatrixRustSDK.xcframework in Frameworks',
    ]);
    const source = project.replace(
      '\t\t\t\tC0FFEE00000000000000B007 /* NotificationService.swift in Sources */,\n',
      '\t\t\t\tC0FFEE00000000000000B007 /* NotificationService.swift in Sources */,\n\t\t\t\tBBBB /* AppDelegate.swift in Sources */,\n',
    );
    expect(projectViolations(source, ownSources)).toEqual([
      'source AppDelegate.swift',
    ]);
  });
});
