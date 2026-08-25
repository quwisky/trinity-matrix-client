import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');

/**
 * Every template that renders `<trn-message-row>` must bind BOTH of its interaction
 * outputs.
 *
 * This exists because one of them was missed. `(action)` has been bound by all three
 * consumers since it was added; `(longPress)`, which carries the mobile action sheet, was
 * wired into the two message lists and not into the thread panel — because that panel does
 * not extend `MessageListBase` and so inherited none of it. The result was silent in every
 * possible way: an `output()` with no subscriber throws nothing, the Android `contextmenu`
 * fallback had been removed on the same path, and no unit test renders a thread reply and
 * presses it. Every action on a thread reply was simply unreachable by touch.
 *
 * A source-shape guard rather than a behavioural test on purpose: what failed was not logic
 * but COVERAGE of a list of call sites, and the next consumer will be added by someone who
 * does not know this list exists.
 */
const OUTPUTS = ['(action)', '(longPress)'];

describe('trn-message-row consumers', () => {
  const templates = globSync('libs/**/*.html', { cwd: workspaceRoot }).filter(
    (file) =>
      readFileSync(join(workspaceRoot, file), 'utf8').includes(
        '<trn-message-row',
      ),
  );

  it('finds the consumers at all, so an empty sweep cannot pass as a clean one', () => {
    // Three today: the virtual list, the simple list, and the thread panel. A drop to zero
    // would mean the glob or the marker changed, and every assertion below would hold
    // vacuously — the classic way a source-shape guard stops guarding in silence.
    expect(templates.length).toBeGreaterThanOrEqual(3);
  });

  it('binds every interaction output in every one of them', () => {
    const missing = templates.flatMap((file) => {
      const source = readFileSync(join(workspaceRoot, file), 'utf8');
      return OUTPUTS.filter((output) => !source.includes(output)).map(
        (output) => `${file} does not bind ${output}`,
      );
    });

    expect(missing).toEqual([]);
  });
});
