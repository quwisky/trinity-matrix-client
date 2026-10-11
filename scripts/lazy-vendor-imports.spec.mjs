import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Feature-only libraries must stay out of the initial bundle.
 *
 * `qr` (about 60 KB) is only needed once a verification code is drawn or scanned, so
 * `QrCodeService` loads it with a dynamic `import()`. A single static value import anywhere
 * in the app graph pulls it back into the first download, and no unit test would notice.
 *
 * `matrix-widget-api` (about 110 KB minified) is only needed once a room widget opens.
 * `widget-bridge-runtime.ts` is the one module that imports it, and `WidgetBridgeService`
 * loads that module with a dynamic `import()`. The SDK used to pull it in anyway: its root
 * entry re-exports `embedded.js` (the client a Matrix widget runs inside), which imports
 * `matrix-widget-api` statically. Trinity's matrix-js-sdk patch drops that re-export.
 *
 * Type-only imports are erased and stay allowed. Specs and stories are not part of the
 * application bundle.
 */

const workspaceRoot = join(import.meta.dirname, '..');
const staticImportOf = (specifier) =>
  new RegExp(
    String.raw`\b(?:import|export)\s+(?!type\b)[^;'"]*?\bfrom\s*['"]${specifier}['"]|\bimport\s*['"]${specifier}['"]`,
    'g',
  );
const staticImport = staticImportOf(String.raw`qr(?:\/[^'"]*)?`);
const WIDGET_RUNTIME =
  'libs/data-access/widgets/src/lib/widget-bridge-runtime.ts';

const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

const staticLazyImports = (source, pattern = staticImport) =>
  [...stripComments(source).matchAll(pattern)].map((match) => match[0]);

const applicationSources = () =>
  globSync(['libs/**/*.ts', 'apps/**/*.ts'], {
    cwd: workspaceRoot,
    exclude: (name) => name === 'node_modules',
  }).filter((file) => !/\.(?:spec|stories)\.ts$/.test(file));

const offendersOf = (pattern, files = applicationSources()) =>
  files.flatMap((file) =>
    staticLazyImports(
      readFileSync(join(workspaceRoot, file), 'utf8'),
      pattern,
    ).map((statement) => `${file}: ${statement.replace(/\s+/g, ' ')}`),
  );

describe('lazy vendor imports', () => {
  it('flags static value imports of qr and ignores the rest', () => {
    expect(staticLazyImports(`import encodeQr from 'qr';`)).toHaveLength(1);
    expect(
      staticLazyImports(`import decodeQr from 'qr/decode.js';`),
    ).toHaveLength(1);
    expect(
      staticLazyImports(`import {\n  encode,\n  type Options,\n} from "qr";`),
    ).toHaveLength(1);
    expect(staticLazyImports(`export * from 'qr';`)).toHaveLength(1);
    expect(staticLazyImports(`import 'qr';`)).toHaveLength(1);

    expect(staticLazyImports(`import type encodeQr from 'qr';`)).toEqual([]);
    expect(staticLazyImports(`const encoder = await import('qr');`)).toEqual(
      [],
    );
    expect(staticLazyImports(`// import encodeQr from 'qr';`)).toEqual([]);
    expect(staticLazyImports(`import { qrcode } from 'qrcode';`)).toEqual([]);
  });

  it('keeps qr out of the application sources', () => {
    expect(offendersOf(staticImport)).toEqual([]);
  });

  it('still loads qr with a dynamic import', () => {
    const service = readFileSync(
      join(workspaceRoot, 'libs/platform-native/src/lib/qr-code.service.ts'),
      'utf8',
    );

    expect(service).toContain("import('qr')");
    expect(service).toContain("import('qr/decode.js')");
  });

  it('imports matrix-widget-api only from the lazily loaded widget runtime', () => {
    const files = applicationSources();
    expect(files).toContain(WIDGET_RUNTIME);

    expect(
      offendersOf(
        staticImportOf(String.raw`matrix-widget-api(?:\/[^'"]*)?`),
        files.filter((file) => file !== WIDGET_RUNTIME),
      ),
    ).toEqual([]);
    expect(
      offendersOf(
        staticImportOf(String.raw`[^'"]*widget-bridge-runtime`),
        files,
      ),
    ).toEqual([]);
    expect(
      readFileSync(
        join(
          workspaceRoot,
          'libs/data-access/widgets/src/lib/widget-bridge.service.ts',
        ),
        'utf8',
      ),
    ).toContain("import('./widget-bridge-runtime')");
  });

  it('keeps the SDK root entry from importing its embedded widget client', () => {
    const root = readFileSync(
      join(workspaceRoot, 'node_modules/matrix-js-sdk/lib/matrix.js'),
      'utf8',
    );

    expect(stripComments(root)).not.toMatch(/['"]\.\/embedded\.js['"]/);
  });
});
