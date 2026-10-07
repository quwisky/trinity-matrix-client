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
 * `matrix-widget-api` is deliberately not listed: matrix-js-sdk imports it statically from
 * `embedded.js`, so it ships in the initial bundle whatever the app does.
 *
 * Type-only imports are erased and stay allowed. Specs and stories are not part of the
 * application bundle.
 */

const workspaceRoot = join(import.meta.dirname, '..');
const LAZY_PACKAGE = String.raw`qr(?:\/[^'"]*)?`;
const staticImport = new RegExp(
  String.raw`\b(?:import|export)\s+(?!type\b)[^;'"]*?\bfrom\s*['"]${LAZY_PACKAGE}['"]|\bimport\s*['"]${LAZY_PACKAGE}['"]`,
  'g',
);

const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

const staticLazyImports = (source) =>
  [...stripComments(source).matchAll(staticImport)].map((match) => match[0]);

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
    const offenders = globSync(['libs/**/*.ts', 'apps/**/*.ts'], {
      cwd: workspaceRoot,
      exclude: (name) => name === 'node_modules',
    })
      .filter((file) => !/\.(?:spec|stories)\.ts$/.test(file))
      .flatMap((file) =>
        staticLazyImports(readFileSync(join(workspaceRoot, file), 'utf8')).map(
          (statement) => `${file}: ${statement.replace(/\s+/g, ' ')}`,
        ),
      );

    expect(offenders).toEqual([]);
  });

  it('still loads qr with a dynamic import', () => {
    const service = readFileSync(
      join(workspaceRoot, 'libs/platform-native/src/lib/qr-code.service.ts'),
      'utf8',
    );

    expect(service).toContain("import('qr')");
    expect(service).toContain("import('qr/decode.js')");
  });
});
