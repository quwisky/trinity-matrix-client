import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');

/**
 * Every template that renders `<trn-message-row>` must bind all of its interaction outputs.
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
 *
 * `.ts` files are swept alongside `.html`, and `apps/` alongside `libs/`: a fourth consumer
 * with an inline `template:` — the idiom every wrapper component in `libs/components` uses —
 * would otherwise be invisible to the guard written to find exactly that omission.
 */
const OUTPUTS = ['action', 'longPress', 'swipe'];

/**
 * Expressions that bind the output to nothing in particular.
 *
 * `(longPress)=""` is a binding the Angular compiler accepts, and so is one wired to a
 * no-op. Neither behaves differently from the omission this guard exists to catch — the
 * press still reaches nothing — and neither is visible to AOT, which only checks that the
 * expression RESOLVES.
 *
 * A denylist and not an analysis, deliberately. Proving a handler does something needs the
 * component's symbol table and its call graph, which is a different tool; what this catches
 * is the shape someone reaches for when they want the guard to stop complaining. A handler
 * that is genuinely empty three calls down is out of reach, and saying so here is better
 * than implying it is covered.
 */
const INERT = /^(?:\s*|noop\(\)|undefined|null|''|""|0|false)$/;

/**
 * Every `<trn-message-row …>` opening tag in a source.
 *
 * Scoped to the tag, not the file. A file-wide search answers "does this file bind
 * `(action)` anywhere", which is a different question: `message-row.component.html:232`
 * already binds `(action)` on the TOOLBAR, so a future consumer composing a toolbar beside
 * the row would satisfy a file-wide check with zero bindings on the row itself. It also
 * misses a second `<trn-message-row>` in another `@if` branch that binds nothing.
 */
const rowTags = (source) =>
  [...source.matchAll(/<trn-message-row\b[^>]*>/g)].map(([tag]) => tag);

/** The expression bound to an output, accepting either attribute quoting style. */
const outputExpression = (tag, output) => {
  const match = new RegExp(
    `\\(${output}\\)\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
  ).exec(tag);
  return match === null ? null : (match[1] ?? match[2] ?? '').trim();
};

/** A binding whose expression does something. Both attribute quotings are accepted. */
const bindsOutput = (tag, output) => {
  const expression = outputExpression(tag, output);
  return expression !== null && !INERT.test(expression);
};

/** Whether an output expression forwards Angular's event value as its own token. */
const forwardsEvent = (tag, output) => {
  const expression = outputExpression(tag, output);
  return (
    expression !== null && /(?:^|[^\w$])\$event(?:$|[^\w$])/.test(expression)
  );
};

describe('trn-message-row consumers', () => {
  const templates = globSync(
    ['libs/**/*.html', 'libs/**/*.ts', 'apps/**/*.html', 'apps/**/*.ts'],
    { cwd: workspaceRoot },
  ).filter(
    (file) =>
      !file.includes('node_modules') &&
      !file.endsWith('.spec.ts') &&
      readFileSync(join(workspaceRoot, file), 'utf8').includes(
        '<trn-message-row',
      ),
  );

  it('finds the consumers at all, so an empty sweep cannot pass as a clean one', () => {
    // Three today: the virtual list, the simple list, and the thread panel. A drop to zero
    // would mean the glob or the marker changed, and every assertion below would hold
    // vacuously — the classic way a source-shape guard stops guarding in silence.
    expect(templates.length).toBeGreaterThanOrEqual(3);
    // And each really yields a tag to inspect, or the per-tag loop below runs zero times
    // and reports nothing missing on every file.
    for (const file of templates) {
      expect(
        rowTags(readFileSync(join(workspaceRoot, file), 'utf8')).length,
      ).toBeGreaterThan(0);
    }
  });

  it('binds every interaction output in every one of them', () => {
    const missing = templates.flatMap((file) => {
      const source = readFileSync(join(workspaceRoot, file), 'utf8');
      return rowTags(source).flatMap((tag, index) =>
        OUTPUTS.filter((output) => !bindsOutput(tag, output)).map(
          (output) => `${file} row #${index + 1} does not bind (${output})`,
        ),
      );
    });

    expect(missing).toEqual([]);
  });

  it('forwards the long-press anchor context from every consumer', () => {
    const missing = templates.flatMap((file) => {
      const source = readFileSync(join(workspaceRoot, file), 'utf8');
      return rowTags(source).flatMap((tag, index) =>
        outputExpression(tag, 'longPress')?.includes('$event')
          ? []
          : [`${file} row #${index + 1} drops the (longPress) $event`],
      );
    });

    expect(missing).toEqual([]);
  });

  it('forwards the committed swipe action from every row', () => {
    const missing = templates.flatMap((file) => {
      const source = readFileSync(join(workspaceRoot, file), 'utf8');
      return rowTags(source).flatMap((tag, index) =>
        forwardsEvent(tag, 'swipe')
          ? []
          : [`${file} row #${index + 1} does not forward swipe $event`],
      );
    });

    expect(missing).toEqual([]);
  });

  it('recognises only a standalone forwarded swipe event', () => {
    expect(
      forwardsEvent(
        '<trn-message-row (swipe)="onRowSwipe(row, $event)" />',
        'swipe',
      ),
    ).toBe(true);
    expect(
      forwardsEvent(
        "<trn-message-row (swipe)='onRowSwipe(row, $event)' />",
        'swipe',
      ),
    ).toBe(true);
    expect(
      forwardsEvent('<trn-message-row (swipe)="onRowSwipe(row)" />', 'swipe'),
    ).toBe(false);
  });
  it('does not count an inert binding as a binding', () => {
    // The parser is the guard. `includes('(longPress)')` — the first spelling here — scores
    // a hit on the attribute alone, so a consumer that wired the output to nothing would
    // have passed while behaving exactly like the one that omitted it.
    expect(
      bindsOutput('<trn-message-row (longPress)="x()" />', 'longPress'),
    ).toBe(true);
    expect(
      bindsOutput("<trn-message-row (longPress)='x()' />", 'longPress'),
    ).toBe(true);
    for (const inert of [
      '',
      ' ',
      'noop()',
      'undefined',
      'null',
      '0',
      'false',
      "''",
    ]) {
      expect(
        bindsOutput(`<trn-message-row (longPress)="${inert}" />`, 'longPress'),
      ).toBe(false);
    }
    expect(bindsOutput('<trn-message-row />', 'longPress')).toBe(false);
  });
});
