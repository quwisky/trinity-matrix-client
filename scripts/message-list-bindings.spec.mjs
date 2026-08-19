import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The two message lists must be bound identically.
 *
 * `rooms.page.html` picks between `trn-virtual-message-list` and `trn-simple-message-list` on
 * a feature flag, and both extend `MessageListBase`, so the two elements carry the same 30
 * bindings. Written out twice, they drift: an input added to one and forgotten on the other
 * gives a timeline that behaves differently depending on a flag most people never touch, and
 * nothing fails.
 *
 * **Why a spec and not a de-duplication.** The obvious fix is `*ngComponentOutlet`, and it
 * does not work here: it can pass inputs but has no way to bind OUTPUTS, and half of these
 * thirty are outputs. Wiring those by hand against a dynamically created instance would trade
 * thirty statically-checked bindings for a string-keyed map plus manual subscriptions — and
 * the type checking is precisely what catches the typo this guard is about. A wrapper
 * component just moves the same two blocks somewhere else.
 *
 * The real fix is for the windowing to be a MODE of one list rather than a second component,
 * which removes the fork instead of policing it. That is a bigger change than this phase, and
 * this spec is what makes deferring it safe rather than merely convenient.
 */

const workspaceRoot = join(import.meta.dirname, '..');
const template = readFileSync(
  join(workspaceRoot, 'libs/feature/rooms/src/lib/rooms/rooms.page.html'),
  'utf8',
);

/** The bindings on one element, in source order, with the element name normalised away. */
function bindingsOf(elementName) {
  const open = template.indexOf(`<${elementName}`);
  if (open === -1) {
    return null;
  }
  const close = template.indexOf('/>', open);
  return template
    .slice(open, close)
    .split('\n')
    .slice(1) // drop the element name itself
    .map((line) => line.trim())
    .filter(Boolean);
}

const virtual = bindingsOf('trn-virtual-message-list');
const simple = bindingsOf('trn-simple-message-list');

describe('message list bindings', () => {
  it('finds both lists in the page, so an empty comparison cannot pass', () => {
    // Without this, renaming either element would make the sweep vacuous and the two could
    // then drift freely — the classic way a source-shape guard stops guarding in silence.
    expect(virtual).not.toBeNull();
    expect(simple).not.toBeNull();
    expect(virtual?.length).toBeGreaterThan(20);
  });

  it('binds the windowed and simple lists identically', () => {
    expect(simple).toEqual(virtual);
  });
});
