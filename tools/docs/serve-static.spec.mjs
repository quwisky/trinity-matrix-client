import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = join(import.meta.dirname, 'serve-static.mjs');
const serve = (base) =>
  spawnSync(
    process.execPath,
    [script, '--root', import.meta.dirname, '--base', base, '--port', '1'],
    { encoding: 'utf8', timeout: 5_000 },
  );

describe('serve-static --base', () => {
  it.each(['/docs//users', '/docs/../etc', 'docs'])('rejects %s', (base) => {
    const result = serve(base);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain('Static base is invalid');
  });

  it('rejects a long invalid base without backtracking', () => {
    const result = serve(`/${'a'.repeat(64)}!`);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain('Static base is invalid');
  });
});
