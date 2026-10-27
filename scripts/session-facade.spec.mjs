import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const allowlistPath = 'architecture/session-facade-allowlist.json';
const namedImport = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g;
const jsSdkFolder = 'libs/data-access/matrix-client/src/lib/js-sdk/';

/** Whether a production source file imports `MatrixClientService`, the session facade. */
export function usesSessionFacade(file, source) {
  if (
    !file.endsWith('.ts') ||
    file.endsWith('.spec.ts') ||
    file.endsWith('.spec-harness.ts') ||
    file.startsWith(jsSdkFolder)
  ) {
    return false;
  }
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  return [...code.matchAll(namedImport)].some(([, specifiers]) =>
    specifiers.split(',').some(
      (specifier) =>
        specifier
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+/)[0] === 'MatrixClientService',
    ),
  );
}

/**
 * Freeze the callers of the MatrixClientService facade (#1153), separately from the SDK-reach
 * ratchet. The allowlist holds the files that still import it; it may only shrink.
 */
describe('Session facade callers', () => {
  const { files: allowlist } = JSON.parse(
    readFileSync(join(workspaceRoot, allowlistPath), 'utf8'),
  );
  const callers = globSync(['apps/**/*.ts', 'libs/**/*.ts'], {
    cwd: workspaceRoot,
    exclude: (name) => name === 'node_modules',
  })
    .filter((file) =>
      usesSessionFacade(file, readFileSync(join(workspaceRoot, file), 'utf8')),
    )
    .sort();

  it('adds no new facade callers', () => {
    expect(callers.filter((file) => !allowlist.includes(file))).toEqual([]);
  });

  it('drops callers that no longer use the facade', () => {
    expect(allowlist.filter((file) => !callers.includes(file))).toEqual([]);
  });

  it('keeps the allowlist sorted and unique', () => {
    expect(allowlist).toEqual([...new Set(allowlist)].sort());
  });
});

describe('usesSessionFacade', () => {
  const file = 'libs/x/src/a.ts';

  it('matches a multi-line barrel import', () => {
    const source =
      "import {\n  Other,\n  MatrixClientService,\n} from '@trinity/data-access/matrix-client';";
    expect(usesSessionFacade(file, source)).toBe(true);
  });

  it('matches a relative import', () => {
    const source =
      "import { MatrixClientService } from '../js-sdk/matrix-client.service';";
    expect(usesSessionFacade(file, source)).toBe(true);
  });

  it('matches a type-only import', () => {
    expect(
      usesSessionFacade(file, "import type { MatrixClientService } from 'x';"),
    ).toBe(true);
  });

  it('ignores a comment that only names the class', () => {
    expect(
      usesSessionFacade(
        file,
        "// MatrixClientService\nimport { Foo } from 'x';",
      ),
    ).toBe(false);
  });

  it('skips specs, harnesses and the js-sdk folder', () => {
    const source = "import { MatrixClientService } from 'x';";
    expect(usesSessionFacade('a.spec.ts', source)).toBe(false);
    expect(usesSessionFacade('a.spec-harness.ts', source)).toBe(false);
    expect(usesSessionFacade(`${jsSdkFolder}a.ts`, source)).toBe(false);
  });
});
