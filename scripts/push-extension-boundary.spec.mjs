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

/**
 * The source without its comments, and its string literals (`"…"` and `"""…"""`), so a quoted word
 * in a comment trips nothing and a multi-line literal is read whole.
 */
function scanned(source) {
  let code = '';
  const literals = [];
  let i = 0;
  while (i < source.length) {
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
    } else if (source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      const stop = end < 0 ? source.length : end + 3;
      literals.push(source.slice(i + 3, end < 0 ? source.length : end));
      code += source.slice(i, stop);
      i = stop;
    } else if (source[i] === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"' && source[j] !== '\n') {
        j += source[j] === '\\' ? 2 : 1;
      }
      literals.push(source.slice(i + 1, j));
      code += source.slice(i, j + 1);
      i = j + 1;
    } else {
      code += source[i];
      i += 1;
    }
  }
  return { code, literals };
}

/** What in one Swift source crosses the boundary. */
function sourceViolations(source) {
  const found = [];
  const { code, literals } = scanned(source);
  for (const [, module] of code.matchAll(
    /^[ \t]*(?:@\w+[ \t]+)*(?:(?:public|package|internal|fileprivate|private)[ \t]+)?import[ \t]+(?:(?:struct|class|enum|protocol|func|var|let|typealias)[ \t]+)?([\w.]+)/gm,
  )) {
    if (!allowedImports.has(module)) found.push(`import ${module}`);
  }
  for (const text of literals) {
    if (
      text.includes('_matrix') &&
      !text.trim().startsWith(allowedMatrixPath)
    ) {
      found.push(`path ${text.trim()}`);
    }
    const segment = text
      .split(/[/?\s]/)
      .find((part) => forbiddenSegments.has(part.toLowerCase()));
    if (segment) found.push(`segment ${segment}`);
  }
  if (/sendToDevice/i.test(code)) found.push('sendToDevice');
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
  // By type: a phase's name is only a comment, and a target can have several of one type.
  const linked = [];
  for (const phase of listed(target, 'buildPhases')) {
    const object = projectObject(project, phase.id);
    const isa = /isa = (\w+);/.exec(object)?.[1];
    const entries = listed(object, 'files').map((entry) => entry.name);
    if (isa === 'PBXFrameworksBuildPhase') linked.push(...entries);
    if (isa === 'PBXSourcesBuildPhase') {
      for (const entry of entries) {
        const file = entry.replace(/ in Sources$/, '');
        if (!ownSources.includes(file)) found.push(`source ${file}`);
      }
    }
  }
  if (linked.join() !== 'TrinityPush in Frameworks') {
    found.push(`frameworks ${linked}`);
  }
  const configurations = /buildConfigurationList = (\w+)/.exec(target)?.[1];
  for (const configuration of listed(
    projectObject(project, configurations ?? ''),
    'buildConfigurations',
  )) {
    const flags = /OTHER_LDFLAGS = (\([^)]*\)|[^;]*);/.exec(
      projectObject(project, configuration.id),
    )?.[1];
    const extra = (flags ?? '')
      .replace(/^\(|\)$/g, '')
      .split(/[\s,]+/)
      .map((flag) => flag.replace(/^"|"$/g, ''))
      .filter((flag) => flag && flag !== '$(inherited)');
    if (extra.length > 0) {
      found.push(`${configuration.name} OTHER_LDFLAGS ${extra.join(' ')}`);
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
    ['let path = """\n/_matrix/client/v3/sync\n"""', 'segment sync'],
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

  it('flags a framework in a second Frameworks phase under another name', () => {
    const project = readFileSync(projectFile, 'utf8')
      .replace(
        '\t\t\t\tC0FFEE00000000000000B00E /* Frameworks */,\n',
        '\t\t\t\tC0FFEE00000000000000B00E /* Frameworks */,\n\t\t\t\tCCCC /* Link Crypto */,\n',
      )
      .replace(
        '/* End PBXFrameworksBuildPhase section */',
        '\t\tCCCC /* Link Crypto */ = {\n\t\t\tisa = PBXFrameworksBuildPhase;\n\t\t\tfiles = (\n\t\t\t\tDDDD /* MatrixRustSDK.xcframework in Frameworks */,\n\t\t\t);\n\t\t};\n/* End PBXFrameworksBuildPhase section */',
      );
    expect(projectViolations(project, ownSources)).toEqual([
      'frameworks TrinityPush in Frameworks,MatrixRustSDK.xcframework in Frameworks',
    ]);
  });

  it('flags linker flags on the extension target', () => {
    const project = readFileSync(projectFile, 'utf8').replace(
      '\t\tC0FFEE00000000000000B010 /* Debug */ = {\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = {\n',
      '\t\tC0FFEE00000000000000B010 /* Debug */ = {\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = {\n\t\t\t\tOTHER_LDFLAGS = (\n\t\t\t\t\t"$(inherited)",\n\t\t\t\t\t"-framework",\n\t\t\t\t\tMatrixRustSDK,\n\t\t\t\t\t"-lolm",\n\t\t\t\t);\n',
    );
    expect(projectViolations(project, ownSources)).toEqual([
      'Debug OTHER_LDFLAGS -framework MatrixRustSDK -lolm',
    ]);
  });

  it('reads nothing in comments', () => {
    expect(
      sourceViolations(
        'import Foundation\n// Never reads "sync" or "keys"; no sendToDevice.\n/* import MatrixRustSDK\n "/_matrix/client/v3/sync" */\nlet url = "https://h/x" // "room_keys"\n',
      ),
    ).toEqual([]);
  });
});
