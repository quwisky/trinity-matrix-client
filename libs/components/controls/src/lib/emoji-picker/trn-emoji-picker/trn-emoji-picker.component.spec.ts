import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Component, signal } from '@angular/core';
import type { ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { PickerComponent } from '@ctrl/ngx-emoji-mart';
import { render } from '@trinity/testing';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { TrnEmojiPick } from '../trn-emoji.model';
import { TrnEmojiPickerComponent } from './trn-emoji-picker.component';

/** The component stylesheet, read from source because jsdom applies no CSS. */
const SHEET = readFileSync(
  join(import.meta.dirname, 'trn-emoji-picker.component.scss'),
  'utf8',
);

/** The vendor picker's debug element. */
function vendorOf(fixture: ComponentFixture<unknown>) {
  return fixture.debugElement.query(By.directive(PickerComponent));
}

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

/**
 * Runs `body` with a controllable ResizeObserver and, optionally, a coarse pointer. `resize`
 * reports a new content width for every observed element, as a rotation would.
 */
async function withObservedWidth<T>(
  coarse: boolean,
  body: (
    resize: (width: number) => void,
    disconnected: () => boolean,
  ) => Promise<T>,
  initialWidth = 0,
): Promise<T> {
  // The panel's width when it first renders; jsdom has no layout, so 0 unless given.
  const measured = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      return {
        width: this.localName === 'trn-emoji-picker-panel' ? initialWidth : 0,
      } as DOMRect;
    });
  const realObserver = globalThis.ResizeObserver;
  const realMatchMedia = globalThis.matchMedia;
  const observers: {
    callback: ResizeObserverCallback;
    targets: Element[];
    disconnected: boolean;
  }[] = [];
  globalThis.ResizeObserver = class {
    private readonly entry: (typeof observers)[number];
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: [], disconnected: false };
      observers.push(this.entry);
    }
    observe(target: Element): void {
      this.entry.targets.push(target);
    }
    unobserve(): void {
      // Not needed by these tests.
    }
    disconnect(): void {
      this.entry.targets = [];
      this.entry.disconnected = true;
    }
  } as unknown as typeof ResizeObserver;
  globalThis.matchMedia = ((query: string) => ({
    ...realMatchMedia(query),
    matches: coarse && query.includes('coarse'),
  })) as typeof globalThis.matchMedia;
  const resize = (width: number) => {
    for (const { callback, targets } of observers) {
      callback(
        targets.map(
          (target) =>
            ({
              target,
              contentRect: { width },
            }) as unknown as ResizeObserverEntry,
        ),
        {} as ResizeObserver,
      );
    }
  };
  try {
    return await body(
      resize,
      () => observers.length > 0 && observers.every((o) => o.disconnected),
    );
  } finally {
    measured.mockRestore();
    globalThis.ResizeObserver = realObserver;
    globalThis.matchMedia = realMatchMedia;
  }
}

/**
 * `render` a filling picker, then report its width (`measure`) until the deferred panel has
 * arrived, measured, and created the vendor grid.
 */
async function renderFilled(
  inputs: Record<string, unknown>,
  measure: () => void = () => undefined,
) {
  const rendered = await render(TrnEmojiPickerComponent, { inputs });
  await vi.waitFor(() => {
    measure();
    rendered.fixture.detectChanges();
    expect(
      rendered.fixture.debugElement.query(By.directive(PickerComponent)),
    ).not.toBeNull();
  });
  return rendered;
}

/** `render`, then let the deferred vendor panel arrive. */
async function renderLoaded<T>(
  ...args: Parameters<typeof render<T>>
): Promise<Awaited<ReturnType<typeof render<T>>>> {
  const rendered = await render<T>(...args);
  await vi.waitFor(() => {
    rendered.fixture.detectChanges();
    expect(
      rendered.fixture.debugElement.query(By.directive(PickerComponent)),
    ).not.toBeNull();
  });
  return rendered;
}

describe('TrnEmojiPickerComponent', () => {
  // The vendor panel is a deferred import, so the first test would otherwise pay for
  // transforming the whole library inside its own 5 s budget.
  beforeAll(async () => {
    await import('./trn-emoji-picker-panel.component');
  }, 60_000);

  /**
   * Fires the VENDOR's own output rather than calling our handler.
   *
   * Reaching for the protected `onSelect` directly left the `(emojiSelect)` binding
   * uncovered: deleting it from the template kept every test in this file green while the
   * picker emitted nothing at all. Going through `PickerComponent` covers the binding and
   * the narrowing in one path, so breaking either fails here.
   */
  const emit = async (emoji: unknown) => {
    const { fixture } = await renderLoaded(HostComponent);
    const vendor = vendorOf(fixture);
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
    const { fixture } = await renderLoaded(TrnEmojiPickerComponent, {
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
    const { fixture } = await renderLoaded(TrnEmojiPickerComponent);
    const vendor = vendorOf(fixture);

    expect(vendor.componentInstance.color).toBe('var(--trinity-accent)');
  });

  it('renders emoji as named buttons instead of labelled generic spans', async () => {
    const { fixture } = await renderLoaded(TrnEmojiPickerComponent);
    const vendor = vendorOf(fixture);

    expect(vendor.componentInstance.useButton).toBe(true);
  });

  it('maps an ordinal Trinity size to the private vendor glyph measurement', async () => {
    const { fixture } = await renderLoaded(TrnEmojiPickerComponent, {
      inputs: { size: 'lg' },
    });
    const vendor = vendorOf(fixture);

    expect(
      (fixture.nativeElement as HTMLElement).getAttribute('data-size'),
    ).toBe('lg');
    expect(vendor.componentInstance.emojiSize).toBe(24);
  });

  it('leaves focus alone by default', async () => {
    const { fixture } = await renderLoaded(TrnEmojiPickerComponent);
    const search = (fixture.nativeElement as HTMLElement).querySelector(
      '.emoji-mart-search input',
    );

    expect(document.activeElement).not.toBe(search);
  });

  it('draws its own frame by default, for a call site with no card around it', async () => {
    const { fixture } = await renderLoaded(TrnEmojiPickerComponent);
    const host = fixture.nativeElement as HTMLElement;

    expect(host).not.toHaveClass('trn-emoji-picker--embedded');
  });

  it('drops its frame when embedded in a surface that already draws the card', async () => {
    const { fixture } = await renderLoaded(TrnEmojiPickerComponent, {
      inputs: { framed: false },
    });
    const host = fixture.nativeElement as HTMLElement;

    expect(host).toHaveClass('trn-emoji-picker');
    expect(host).toHaveClass('trn-emoji-picker--embedded');
  });

  it('takes the border, background, radius and shadow off the grid and its placeholder when embedded', () => {
    // jsdom applies no CSS, so the embedded rule is read from the source: both the vendor
    // grid and the placeholder standing in for it must lose every part of the frame.
    const sheet = SHEET;
    const embedded =
      /&\.trn-emoji-picker--embedded\s*\{([\s\S]*?)\n {4}\}/u.exec(sheet)?.[1];

    expect(embedded).toBeDefined();
    expect(embedded).toMatch(
      /\.emoji-mart,\s*\.trn-emoji-picker__placeholder\s*\{/u,
    );
    for (const declaration of [
      'border-width: 0;',
      'border-radius: 0;',
      'background: transparent;',
      'box-shadow: none;',
    ]) {
      expect(embedded).toContain(declaration);
    }
  });

  it('keeps the vendor fixed width by default, nine to a line', async () => {
    const { fixture } = await renderLoaded(TrnEmojiPickerComponent);
    const vendor = vendorOf(fixture);

    expect(vendor.componentInstance.perLine).toBe(9);
    expect(vendor.componentInstance.style).toEqual({});
    expect(fixture.nativeElement).not.toHaveClass('trn-emoji-picker--fill');
  });

  it('fills its width with 44px touch cells, recomputing the columns when the width changes', async () => {
    await withObservedWidth(
      true,
      async (resize) => {
        const { fixture } = await renderFilled({ layout: 'fill', size: 'lg' });
        const host = fixture.nativeElement as HTMLElement;
        const vendor = vendorOf(fixture);

        expect(host).toHaveClass('trn-emoji-picker--fill');
        expect(vendor.componentInstance.style).toEqual({ width: '100%' });
        expect(vendor.componentInstance.perLine).toBe(8);
        expect(
          host
            .querySelector<HTMLElement>('trn-emoji-picker-panel')
            ?.style.getPropertyValue('--trn-emoji-cell-padding'),
        ).toBe('10px');
        expect(vendor.componentInstance.emojiSize).toBe(25);

        // Wider, as on rotation: fifteen 46px cells across 700px.
        resize(700);
        fixture.detectChanges();
        expect(
          host
            .querySelector<HTMLElement>('trn-emoji-picker-panel')
            ?.style.getPropertyValue('--trn-emoji-cell-padding'),
        ).toBe('11px');
        expect(vendor.componentInstance.emojiSize).toBe(24);
        expect(vendor.componentInstance.perLine).toBe(15);
      },
      366,
    );
  });

  it('refreshes the frequently-used row when its surface shows it again', async () => {
    const { fixture } = await renderLoaded(TrnEmojiPickerComponent, {
      inputs: { shown: 1 },
    });
    const vendor = vendorOf(fixture).componentInstance as PickerComponent;
    const recentRow = () =>
      fixture.nativeElement.querySelector(
        'section.emoji-mart-category[aria-label="Frequently Used"]',
      ) as HTMLElement;
    try {
      // A pick, through the vendor's own handler: it stores the emoji, but reads storage into
      // the row only when the row is created.
      vendor.handleEmojiClick({
        $event: new MouseEvent('click'),
        emoji: { id: 'tada', native: '🎉', colons: ':tada:' },
      } as unknown as Parameters<PickerComponent['handleEmojiClick']>[0]);
      fixture.detectChanges();
      expect(recentRow().textContent).not.toContain('🎉');

      // A surface that kept the picker shows it again.
      const measured = vi.spyOn(vendor, 'updateCategoriesSize');
      fixture.componentRef.setInput('shown', 2);
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(recentRow().textContent).toContain('🎉');
      });
      // Where each category starts is measured again once the row is drawn, so the anchor
      // bar follows the grid after the row grew.
      expect(measured).toHaveBeenCalled();
    } finally {
      localStorage.removeItem('emoji-mart.frequently');
      localStorage.removeItem('emoji-mart.last');
    }
  });

  describe('with recent emoji from the account', () => {
    const recentRow = (fixture: { nativeElement: HTMLElement }) =>
      Array.from(
        fixture.nativeElement.querySelectorAll(
          'section.emoji-mart-category[aria-label="Frequently Used"] .emoji-mart-emoji',
        ),
        (emoji) => emoji.textContent?.trim(),
      );

    it('shows them first, in their order, instead of this device’s own row', async () => {
      const { fixture } = await renderLoaded(TrnEmojiPickerComponent, {
        inputs: { recent: ['🎉', '🚀'] },
      });

      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(recentRow(fixture)).toEqual(['🎉', '🚀']);
      });
    });

    it('keeps this device’s own row without them', async () => {
      const { fixture } = await renderLoaded(TrnEmojiPickerComponent);
      const vendor = vendorOf(fixture).componentInstance as PickerComponent;

      expect(vendor.recent).toBeUndefined();
    });

    it('keeps the device row for an empty list', async () => {
      const { fixture } = await renderLoaded(TrnEmojiPickerComponent, {
        inputs: { recent: [] },
      });
      const vendor = vendorOf(fixture).componentInstance as PickerComponent;

      expect(vendor.recent).toBeUndefined();
    });

    it("keeps the open grid when the account's first pick arrives", async () => {
      const { fixture } = await renderLoaded(TrnEmojiPickerComponent, {
        inputs: { recent: [] },
      });
      const vendor = () =>
        fixture.debugElement.query(By.directive(PickerComponent))
          ?.componentInstance as PickerComponent | undefined;
      const grid = vendor();

      fixture.componentRef.setInput('recent', ['🎉']);
      fixture.detectChanges();
      expect(vendor()).toBe(grid);
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(grid?.recent).toEqual(['tada']);
      });
      expect(vendor()).toBe(grid);
    });

    it('passes each emoji once, whatever its skin tone', async () => {
      const { fixture } = await renderLoaded(TrnEmojiPickerComponent, {
        inputs: { recent: ['👍', '👍🏽', '🎉'] },
      });
      const vendor = vendorOf(fixture).componentInstance as PickerComponent;

      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(vendor.recent).toEqual(['+1', 'tada']);
      });
    });

    it('shows a changed list when its surface shows it again', async () => {
      const { fixture } = await renderLoaded(TrnEmojiPickerComponent, {
        inputs: { recent: ['🎉'], shown: 1 },
      });

      fixture.componentRef.setInput('recent', ['🚀', '🎉']);
      fixture.componentRef.setInput('shown', 2);

      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(recentRow(fixture)).toEqual(['🚀', '🎉']);
      });
    });
  });

  it('creates the vendor grid with the measured line, when filling a host that has a width', async () => {
    // The vendor sizes its frequently-used row from `perLine` once, when it is created, so
    // the grid waits for the host's width rather than starting at nine and changing.
    await withObservedWidth(
      true,
      async () => {
        const { fixture } = await renderFilled({ layout: 'fill' });
        const vendor = vendorOf(fixture);

        expect(vendor.componentInstance.perLine).toBe(8);
      },
      366,
    );
  });

  it('asks the vendor for no more than its sixteen default frequent emoji on a wide row', async () => {
    // Eighteen 45px cells fit 820px; the vendor fills its frequently-used row from a list of
    // sixteen defaults, and asking for more empties the row ("No Emoji Found").
    await withObservedWidth(
      true,
      async () => {
        const { fixture } = await renderFilled({ layout: 'fill', size: 'lg' });
        const vendor = vendorOf(fixture);

        expect(vendor.componentInstance.perLine).toBe(16);
      },
      820,
    );
  });

  it('starts at the vendor line on a host with no layout yet, then fits its cells to the width', async () => {
    await withObservedWidth(true, async (resize) => {
      const { fixture } = await renderFilled({ layout: 'fill' });
      const vendor = vendorOf(fixture);
      const panel = (
        fixture.nativeElement as HTMLElement
      ).querySelector<HTMLElement>('trn-emoji-picker-panel');

      expect(vendor.componentInstance.perLine).toBe(9);
      expect(panel?.style.getPropertyValue('--trn-emoji-cell-padding')).toBe(
        '6px',
      );

      resize(366);
      fixture.detectChanges();
      // Eight 45px cells; a 21px glyph pads by a whole 12px.
      expect(panel?.style.getPropertyValue('--trn-emoji-cell-padding')).toBe(
        '12px',
      );
      expect(vendor.componentInstance.perLine).toBe(8);
    });
  });

  it('stops observing its width once destroyed', async () => {
    await withObservedWidth(true, async (resize, disconnected) => {
      const { fixture } = await renderFilled({ layout: 'fill' }, () =>
        resize(366),
      );

      expect(disconnected()).toBe(false);
      fixture.destroy();
      expect(disconnected()).toBe(true);
    });
  });

  it('lets the focus ring of its search show past the grid when embedded', () => {
    // The panel insets the embedded grid, so the search's ring falls outside `.emoji-mart`;
    // the framed picker's clip would cut it off at both sides.
    const sheet = SHEET;
    const embedded =
      /&\.trn-emoji-picker--embedded\s*\{([\s\S]*?)\n {4}\}/u.exec(sheet)?.[1];

    expect(embedded).toMatch(
      /\.emoji-mart,\s*\.trn-emoji-picker__placeholder\s*\{[^}]*overflow: visible;/u,
    );
  });

  it('keeps the vendor cell on a fine pointer when filling', async () => {
    await withObservedWidth(
      false,
      async () => {
        const { fixture } = await renderFilled({ layout: 'fill' });
        const vendor = vendorOf(fixture);

        // 366 / 32 = 11 columns of the medium picker's 32px cell, widened to 33px.
        expect(vendor.componentInstance.perLine).toBe(11);
      },
      366,
    );
  });

  it('spans the category bar, search and section headers across the grid width when filling', () => {
    const sheet = SHEET;
    const fill = /&\.trn-emoji-picker--fill\s*\{([\s\S]*?)\n {4}\}/u.exec(
      sheet,
    )?.[1];

    expect(fill).toBeDefined();
    for (const selector of [
      '.emoji-mart-anchors',
      '.emoji-mart-search',
      '.emoji-mart-scroll',
      '.emoji-mart-category-label span',
    ]) {
      expect(fill).toContain(selector);
    }
    expect(fill).toContain('padding-inline: 0;');
    // The vendor promotes its scroll area to its own layer; filling, that layer left a
    // hairline of stale paint under the section headings in Chromium.
    expect(fill).toMatch(/\.emoji-mart-scroll\s*\{\s*will-change: auto;/u);
    expect(fill).toContain('padding: var(--trn-emoji-cell-padding');
  });

  it('never puts the vendor dark class on the element, even on a dark OS', async () => {
    // `darkMode` is pinned `false`, and the dark OS here is the whole point. The vendor's
    // default is not `false` — it is `matchMedia('(prefers-color-scheme: dark)').matches`,
    // so an UNBOUND input follows the desktop. This suite's global matchMedia stub reports
    // light, which is exactly what let an earlier version of this test pass against a
    // picker that would have carried `.emoji-mart-dark`, and its ten rules at (0,3,0), for
    // every user on a dark desktop. Removing the binding fails this.
    const html = await withDarkOs(async () => {
      const { fixture } = await renderLoaded(TrnEmojiPickerComponent);
      return (fixture.nativeElement as HTMLElement).innerHTML;
    });

    expect(html).not.toContain('emoji-mart-dark');
  });

  it('keeps every unencapsulated rule inside the host class', () => {
    // `ViewEncapsulation.None` means these rules are global the moment they load. A rule
    // that forgot the `.trn-emoji-picker` prefix would restyle `.emoji-mart` anywhere —
    // and, being a stylesheet, would do it silently: jsdom applies no CSS, so no rendering
    // test could catch it. Asserted on the source instead.
    const sheet = SHEET;
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
