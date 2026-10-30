import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const jsSdkFolder = 'libs/data-access/matrix-client/src/lib/js-sdk/';

/** Whether a production source file names `MatrixClientService`, the session facade, outside a comment. */
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
  return /\bMatrixClientService\b/.test(code);
}

/** Only matrix-client's `js-sdk/` folder imports the MatrixClientService facade (#1153). */
describe('Session facade callers', () => {
  it('has no facade callers outside the js-sdk folder', () => {
    const callers = globSync(['apps/**/*.ts', 'libs/**/*.ts'], {
      cwd: workspaceRoot,
      exclude: (name) => name === 'node_modules',
    }).filter((file) =>
      usesSessionFacade(file, readFileSync(join(workspaceRoot, file), 'utf8')),
    );
    expect(callers).toEqual([]);
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

  it('matches a namespace import, a re-export and a dynamic import', () => {
    for (const source of [
      "import * as mc from '@trinity/data-access/matrix-client';\ninject(mc.MatrixClientService);",
      "export { MatrixClientService } from '@trinity/data-access/matrix-client';",
      "const { MatrixClientService } = await import('@trinity/data-access/matrix-client');",
    ]) {
      expect(usesSessionFacade(file, source), source).toBe(true);
    }
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
