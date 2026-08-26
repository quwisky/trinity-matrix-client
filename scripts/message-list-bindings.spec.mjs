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

/**
 * The bindings on one element, as a SET, with the element name normalised away.
 *
 * A set and not a list: what must not drift is which bindings exist, and comparing source
 * order would also fail when someone reorders attributes on one element — a diff with no
 * behavioural meaning, and the kind of false alarm that gets a guard deleted.
 *
 * The element's own tag must sit alone on its first line (prettier formats it that way) and
 * the tag must self-close. Both are asserted rather than assumed: this reads source text, so
 * every parsing assumption it makes is a way for it to stop guarding without saying so.
 */
function bindingsOf(elementName, source = template) {
  const open = source.indexOf(`<${elementName}`);
  if (open === -1) {
    return null;
  }
  const close = source.indexOf('/>', open);
  if (close === -1) {
    return null;
  }
  const [tagLine, ...bindingLines] = source.slice(open, close).split('\n');
  // `<trn-x` and nothing else. A binding sharing the line would be silently dropped.
  if (tagLine.trim() !== `<${elementName}`) {
    return null;
  }
  return new Set(bindingLines.map((line) => line.trim()).filter(Boolean));
}

/**
 * The bindings on a SINGLE-LINE self-closing element, as a set.
 *
 * `bindingsOf` above requires the tag alone on its first line, which is how prettier formats
 * a thirty-binding element and NOT how it formats a short one: `<trn-typing-indicator
 * [names]="typingNames()" />` fits in 47 characters and stays on one line. Feeding that to
 * `bindingsOf` returns null, which would compare null to null and pass while guarding
 * nothing — so the shape gets its own parser rather than a loosened shared one.
 */
function inlineBindingsOf(elementName, source) {
  const open = source.indexOf(`<${elementName}`);
  if (open === -1) {
    return null;
  }
  const close = source.indexOf('/>', open);
  if (close === -1) {
    return null;
  }
  const body = source.slice(open + elementName.length + 1, close);
  // The `/>` found above is only THIS element's if nothing closed a tag before it. Without
  // this, an element rewritten as `<trn-x …></trn-x>` runs the scan on to the next `/>` in
  // the file — measured, that picked up `<trn-message-composer` and all twenty of its
  // bindings, and every assertion below still passed while comparing the wrong element.
  // `bindingsOf` defends against the same thing with its tag-line check.
  if (body.includes('>')) {
    return null;
  }
  return new Set(body.trim().split(/\s+/).filter(Boolean));
}

const listTemplates = {
  virtual:
    'libs/feature/rooms/src/lib/message-list/virtual-message-list/virtual-message-list.component.html',
  simple:
    'libs/feature/rooms/src/lib/message-list/simple-message-list/simple-message-list.component.html',
};

const typingBindings = Object.fromEntries(
  Object.entries(listTemplates).map(([key, path]) => [
    key,
    inlineBindingsOf(
      'trn-typing-indicator',
      readFileSync(join(workspaceRoot, path), 'utf8'),
    ),
  ]),
);

const virtual = bindingsOf('trn-virtual-message-list');
const simple = bindingsOf('trn-simple-message-list');

describe('message list bindings', () => {
  it('finds both lists in the page, so an empty comparison cannot pass', () => {
    // Without this, renaming either element would make the sweep vacuous and the two could
    // then drift freely — the classic way a source-shape guard stops guarding in silence.
    expect(virtual).not.toBeNull();
    expect(simple).not.toBeNull();
    expect(virtual?.size).toBeGreaterThan(20);
  });

  it('binds the windowed and simple lists identically', () => {
    // Set equality, so the report names the bindings that differ rather than dumping two
    // thirty-line lists and leaving the reader to diff them by eye.
    const onlyVirtual = [...(virtual ?? [])].filter((b) => !simple?.has(b));
    const onlySimple = [...(simple ?? [])].filter((b) => !virtual?.has(b));

    expect({ onlyVirtual, onlySimple }).toEqual({
      onlyVirtual: [],
      onlySimple: [],
    });
  });

  it('finds the typing indicator in both list templates', () => {
    // Same anti-vacuity check as above, and for the same reason: two nulls compare equal.
    expect(typingBindings.virtual).not.toBeNull();
    expect(typingBindings.simple).not.toBeNull();
    expect(typingBindings.virtual).toContain('[names]="typingNames()"');
  });

  it('binds the typing indicator identically in both lists', () => {
    expect([...(typingBindings.virtual ?? [])].sort()).toEqual(
      [...(typingBindings.simple ?? [])].sort(),
    );
  });

  it('leaves the announcement to the lists, which own it', () => {
    // `announce` defaults true and is set false ONLY in the thread panel, whose typists are
    // the room's and are already announced by the list behind it. A list opting out would
    // silence the typing announcement for screen readers altogether — and symmetrically, so
    // the identity check above cannot see it.
    for (const [list, bindings] of Object.entries(typingBindings)) {
      expect(
        [...(bindings ?? [])].filter((binding) =>
          binding.startsWith('[announce]'),
        ),
        `${list} list must not opt out of announcing`,
      ).toEqual([]);
    }
  });
});
