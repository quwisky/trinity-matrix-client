import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Component, signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { PickerComponent } from '@ctrl/ngx-emoji-mart';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import type { TrnEmojiPick } from '../trn-emoji.model';
import { TrnEmojiPickerComponent } from './trn-emoji-picker.component';

/** Host component, so the output can be observed the way a call site sees it. */
@Component({
  imports: [TrnEmojiPickerComponent],
  template: `<trn-emoji-picker (picked)="picks.set([...picks(), $event])" />`,
})
class HostComponent {
  readonly picks = signal<TrnEmojiPick[]>([]);
}

/**
 * Runs `body` with the OS reporting a dark colour scheme.
 *
 * Restored by hand rather than through `vi.unstubAllGlobals()`, which would strip the
 * suite-wide stub `test-setup.base.ts` installs and leave the rest of the file rendering
 * against a jsdom that has no `matchMedia` at all.
 */
async function withDarkOs<T>(body: () => Promise<T>): Promise<T> {
  const real = globalThis.matchMedia;
  globalThis.matchMedia = ((query: string) => ({
    ...real(query),
    matches: true,
  })) as typeof globalThis.matchMedia;
  try {
    return await body();
  } finally {
    globalThis.matchMedia = real;
  }
}

/**
 * Selectors that would escape the host class once this sheet is global.
 *
 * Brace-depth aware rather than line-shaped. The line-shaped version this replaces looked
 * only at lines that both began at column 0 and contained `{`, which let two shapes
 * through: a multi-line selector list whose LAST line happens to be scoped
 * (`.emoji-mart .a,` / `.trn-emoji-picker .b {`), and anything nested inside a top-level
 * at-rule, since `@media` never matched the filter in the first place.
 */
function unscopedSelectors(scss: string): string[] {
  const source = scss.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const escaped: string[] = [];
  /** One entry per open block: whether it scopes what it contains. */
  const scoping: boolean[] = [];
  let prelude = '';

  for (const char of source) {
    if (char === '{') {
      const selectors = prelude
        .split(',')
        .map((selector) => selector.trim())
        .filter(Boolean);
      // An at-rule (`@media`, `@supports`) scopes nothing — its contents are still subject
      // to whatever encloses IT, so it must not reset the check.
      const isAtRule = selectors[0]?.startsWith('@') ?? false;
      if (!isAtRule && !scoping.some(Boolean)) {
        escaped.push(
          ...selectors.filter(
            (selector) => !selector.startsWith('.trn-emoji-picker'),
          ),
        );
      }
      scoping.push(
        !isAtRule &&
          selectors.every((selector) =>
            selector.startsWith('.trn-emoji-picker'),
          ),
      );
      prelude = '';
    } else if (char === '}') {
      scoping.pop();
      prelude = '';
    } else if (char === ';') {
      prelude = '';
    } else {
      prelude += char;
    }
  }

  return escaped;
}

describe('TrnEmojiPickerComponent', () => {
  /**
   * Fires the VENDOR's own output rather than calling our handler.
   *
   * Reaching for the protected `onSelect` directly left the `(emojiSelect)` binding
   * uncovered: deleting it from the template kept every test in this file green while the
   * picker emitted nothing at all. Going through `PickerComponent` covers the binding and
   * the narrowing in one path, so breaking either fails here.
   */
  const emit = async (emoji: unknown) => {
    const { fixture } = await render(HostComponent);
    const vendor = fixture.debugElement.query(By.directive(PickerComponent));
    vendor.componentInstance.emojiSelect.emit({
      emoji,
      $event: new Event('click'),
    });
    fixture.detectChanges();
    return fixture.componentInstance.picks();
  };

  it('narrows a vendor selection to the three fields Trinity uses', async () => {
    const picks = await emit({
      native: '🚀',
      id: 'rocket',
      colons: ':rocket:',
      skin: 3,
      unified: '1f680',
    });

    expect(picks).toEqual([{ native: '🚀', id: 'rocket', colons: ':rocket:' }]);
  });

  // The reason this narrowing exists. A pick with no character is not insertable, and the
  // two call sites used to disagree about it BY ACCIDENT: the reaction dialog closed with
  // `null` — indistinguishable from a dismissal — while the composer silently did nothing.
  // Neither was a decision anyone made. One render per test: `render()` configures the
  // TestBed, which cannot be done twice in one case.
  it('drops a selection whose emoji has no native character', async () => {
    expect(await emit({ id: 'custom', colons: ':custom:' })).toEqual([]);
  });

  it('drops a selection with no emoji at all', async () => {
    expect(await emit(undefined)).toEqual([]);
  });

  it('can be targeted by aria-controls, and claims no role of its own', async () => {
    const { fixture } = await render(TrnEmojiPickerComponent, {
      inputs: { pickerId: 'reaction-emoji-picker' },
    });
    const host = fixture.nativeElement as HTMLElement;

    // The composer's trigger carries `aria-expanded` and had nothing to point at.
    expect(host.getAttribute('id')).toBe('reaction-emoji-picker');

    // Deliberately roleless. In the reaction flow this sits inside a CDK dialog container
    // that already has `role="dialog"` — a role here nests one dialog in another — and in
    // the composer it is a non-modal inline panel with no focus trap, where `dialog`
    // promises focus management that does not exist. Naming belongs to the CDK container
    // or to the trigger, not here.
    expect(host.getAttribute('role')).toBeNull();
    expect(host.getAttribute('aria-label')).toBeNull();
  });

  it('hands the vendor Trinity’s accent token', async () => {
    // The accent reaches the DOM as an INLINE style — the anchor bar's background, and
    // `color` on the selected category anchor, which its icon inherits through
    // `fill: currentColor`. Neither can be reached from our stylesheet without
    // `!important`, so the token is passed through the vendor's own input. Drop this
    // binding and the selected category renders emoji-mart's #ae65c5 again.
    const { fixture } = await render(TrnEmojiPickerComponent);
    const vendor = fixture.debugElement.query(By.directive(PickerComponent));

    expect(vendor.componentInstance.color).toBe('var(--trinity-accent)');
  });

  it('never puts the vendor dark class on the element, even on a dark OS', async () => {
    // `darkMode` is pinned `false`, and the dark OS here is the whole point. The vendor's
    // default is not `false` — it is `matchMedia('(prefers-color-scheme: dark)').matches`,
    // so an UNBOUND input follows the desktop. This suite's global matchMedia stub reports
    // light, which is exactly what let an earlier version of this test pass against a
    // picker that would have carried `.emoji-mart-dark`, and its ten rules at (0,3,0), for
    // every user on a dark desktop. Removing the binding fails this.
    const html = await withDarkOs(async () => {
      const { fixture } = await render(TrnEmojiPickerComponent);
      return (fixture.nativeElement as HTMLElement).innerHTML;
    });

    expect(html).not.toContain('emoji-mart-dark');
  });

  it('keeps every unencapsulated rule inside the host class', () => {
    // `ViewEncapsulation.None` means these rules are global the moment they load. A rule
    // that forgot the `.trn-emoji-picker` prefix would restyle `.emoji-mart` anywhere —
    // and, being a stylesheet, would do it silently: jsdom applies no CSS, so no rendering
    // test could catch it. Asserted on the source instead.
    const sheet = readFileSync(
      join(import.meta.dirname, 'trn-emoji-picker.component.scss'),
      'utf8',
    );
    expect(unscopedSelectors(sheet)).toEqual([]);
  });

  it('catches the two shapes the line-based scoping check used to miss', () => {
    // The guard above is only worth anything if it can fail, and its predecessor could not
    // fail on either of these: the first hides an unscoped selector on a line carrying no
    // `{`, the second behind an at-rule that never matched the old line filter at all.
    expect(
      unscopedSelectors(
        '.emoji-mart .a,\n.trn-emoji-picker .b { color: red; }',
      ),
    ).toEqual(['.emoji-mart .a']);
    expect(
      unscopedSelectors(
        '@media (min-width: 40rem) {\n  .emoji-mart { color: red; }\n}',
      ),
    ).toEqual(['.emoji-mart']);

    // And it still passes what it should: nesting under the host class, at any depth.
    expect(
      unscopedSelectors(
        '.trn-emoji-picker {\n  @media (min-width: 40rem) {\n    .emoji-mart { color: red; }\n  }\n}',
      ),
    ).toEqual([]);
  });
});
