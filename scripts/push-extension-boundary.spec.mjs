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
  readdirSync(directory)
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

const forbiddenCalls = [
  { name: '/sync', pattern: /\/sync\b/ },
  { name: '/keys/', pattern: /\/keys\// },
  { name: 'sendToDevice', pattern: /sendToDevice/i },
];

/** What in one Swift source crosses the boundary. */
function violations(source) {
  const found = [];
  for (const [, module] of source.matchAll(
    /^[ \t]*(?:@testable[ \t]+)?import[ \t]+(?:(?:struct|class|enum|protocol|func|var|let|typealias)[ \t]+)?([\w.]+)/gm,
  )) {
    if (!allowedImports.has(module)) found.push(`import ${module}`);
  }
  for (const { name, pattern } of forbiddenCalls) {
    if (pattern.test(source)) found.push(name);
  }
  return found;
}

/** The Swift packages a target of the Xcode project links. */
function packageProducts(project, target) {
  const start = project.indexOf(
    `/* ${target} */ = {\n\t\t\tisa = PBXNativeTarget;`,
  );
  const block = project.slice(start, project.indexOf('\n\t\t};', start));
  const list =
    /packageProductDependencies = \(([^)]*)\)/.exec(block)?.[1] ?? '';
  return [...list.matchAll(/\/\* (.+?) \*\//g)].map((match) => match[1]);
}

describe('notification extension boundary', () => {
  it('found the extension and its library, so an empty glob cannot pass', () => {
    expect(files.map((f) => f.split('/').pop())).toContain(
      'NotificationService.swift',
    );
    expect(files.map((f) => f.split('/').pop())).toContain(
      'MatrixPushAPI.swift',
    );
  });

  it.each(files)(
    '%s imports no crypto and calls no sync, keys or to-device',
    (file) => {
      expect(violations(readFileSync(file, 'utf8'))).toEqual([]);
    },
  );

  it('links only TrinityPush into the extension', () => {
    const project = readFileSync(
      join(root, 'ios/App/App.xcodeproj/project.pbxproj'),
      'utf8',
    );
    expect(packageProducts(project, 'NotificationService')).toEqual([
      'TrinityPush',
    ]);
  });

  it('gives TrinityPush no package dependencies', () => {
    const manifest = readFileSync(join(packageRoot, 'Package.swift'), 'utf8');
    expect(manifest).not.toMatch(/\.package\(/);
  });

  it('flags a planted call and a planted crypto import', () => {
    expect(
      violations(
        'import Foundation\nlet url = base + "/_matrix/client/v3/sync?timeout=0"\n',
      ),
    ).toEqual(['/sync']);
    expect(violations('import MatrixRustSDK\n')).toEqual([
      'import MatrixRustSDK',
    ]);
    expect(violations('let path = "/_matrix/client/v3/keys/query"\n')).toEqual([
      '/keys/',
    ]);
    expect(violations('client.sendToDevice(type, payload)\n')).toEqual([
      'sendToDevice',
    ]);
  });
});
