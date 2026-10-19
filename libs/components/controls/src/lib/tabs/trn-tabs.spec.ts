import { Dir } from '@angular/cdk/bidi';
import { Component, signal } from '@angular/core';
import { fireEvent, render, within, type RenderResult } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TrnTab } from './trn-tab';
import { TrnTabList } from './trn-tab-list';
import { TrnTabPanel } from './trn-tab-panel';
import { TrnTabs, type TrnTabsActivation } from './trn-tabs';

@Component({
  imports: [TrnTabs, TrnTabList, TrnTab, TrnTabPanel, Dir],
  template: `
    <div [dir]="dir()">
      <div trnTabs [activation]="activation()" [(value)]="value">
        <div trnTabList aria-label="Picker type">
          @for (tab of tabs(); track tab) {
            <button
              [trnTab]="tab"
              [disabled]="tab === disabledTab()"
              [attr.data-testid]="'tab-' + tab"
            >
              {{ tab }}
            </button>
          }
        </div>
        @for (tab of tabs(); track tab) {
          <div [trnTabPanel]="tab" [focusable]="focusable()">
            Panel {{ tab }}
          </div>
        }
      </div>
      <div trnTabs value="one">
        <div trnTabList aria-label="Second">
          <button trnTab="one">one</button>
        </div>
        <div trnTabPanel="one">Second panel</div>
        <div trnTabPanel="orphan">No tab of its own</div>
      </div>
    </div>
  `,
})
class HostComponent {
  readonly activation = signal<TrnTabsActivation>('automatic');
  readonly value = signal<string | undefined>('gifs');
  readonly tabs = signal(['gifs', 'stickers', 'emoji']);
  readonly disabledTab = signal<string | null>(null);
  readonly focusable = signal(true);
  readonly dir = signal<'ltr' | 'rtl'>('ltr');
}

let view: RenderResult<HostComponent>;

async function renderTabs(
  setup: (host: HostComponent) => void = () => undefined,
) {
  view = await render(HostComponent);
  setup(view.fixture.componentInstance);
  await view.fixture.whenStable();
  return view.fixture.componentInstance;
}

const tab = (name: string) => view.getByTestId(`tab-${name}`);

async function press(target: HTMLElement, key: string) {
  fireEvent.keyDown(target, { key });
  await view.fixture.whenStable();
}

const tabStops = () =>
  within(view.getByRole('tablist', { name: 'Picker type' }))
    .getAllByRole('tab')
    .filter((element) => element.getAttribute('tabindex') === '0');

describe('trnTabs', () => {
  it('follows the WAI-ARIA tab roles, with the caller naming the list', async () => {
    await renderTabs();

    const list = view.getByRole('tablist', { name: 'Picker type' });
    expect(list).toHaveAttribute('aria-orientation', 'horizontal');
    expect(tab('gifs')).toHaveAttribute('role', 'tab');
    expect(tab('gifs')).toHaveAttribute('type', 'button');
    expect(tab('gifs')).toHaveAttribute('aria-selected', 'true');
    expect(tab('emoji')).toHaveAttribute('aria-selected', 'false');
  });

  it('points each tab at its panel and each panel back at its tab', async () => {
    await renderTabs();

    for (const name of ['gifs', 'stickers', 'emoji']) {
      const panel = document.getElementById(
        tab(name).getAttribute('aria-controls') ?? '',
      );
      expect(panel).toHaveAttribute('role', 'tabpanel');
      expect(panel).toHaveAttribute('aria-labelledby', tab(name).id);
      expect(panel).toHaveTextContent(`Panel ${name}`);
    }
  });

  it('shows only the selected panel', async () => {
    await renderTabs();

    expect(view.getByRole('tabpanel', { name: 'gifs' })).toHaveTextContent(
      'Panel gifs',
    );
    expect(view.getByText('Panel emoji')).not.toBeVisible();
  });

  it('keeps element ids unique when two tab sets use the same values', async () => {
    await renderTabs((host) => host.tabs.set(['one', 'two']));

    const ids = Array.from(
      document.querySelectorAll('[role=tab], [role=tabpanel]'),
      (element) => element.id,
    );
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(ids.length);
    expect(view.getByText('Panel one').id).toMatch(/^trn-tabs-\d+-panel-one$/);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('moves with the arrow keys and wraps at both ends', async () => {
    await renderTabs();
    tab('gifs').focus();

    await press(tab('gifs'), 'ArrowRight');
    expect(tab('stickers')).toHaveFocus();
    await press(tab('stickers'), 'ArrowRight');
    await press(tab('emoji'), 'ArrowRight');
    expect(tab('gifs')).toHaveFocus();
    await press(tab('gifs'), 'ArrowLeft');
    expect(tab('emoji')).toHaveFocus();
  });

  it('moves to the first and last tab with Home and End', async () => {
    await renderTabs();
    tab('gifs').focus();

    await press(tab('gifs'), 'End');
    expect(tab('emoji')).toHaveFocus();
    await press(tab('emoji'), 'Home');
    expect(tab('gifs')).toHaveFocus();
  });

  it('selects the tab it moves to by default (automatic activation)', async () => {
    const host = await renderTabs();
    tab('gifs').focus();

    await press(tab('gifs'), 'ArrowRight');

    expect(tab('stickers')).toHaveAttribute('aria-selected', 'true');
    expect(host.value()).toBe('stickers');
    expect(tabStops()).toEqual([tab('stickers')]);
  });

  describe('with manual activation', () => {
    it('moves focus and the single tab stop without selecting', async () => {
      const host = await renderTabs((h) => h.activation.set('manual'));
      tab('gifs').focus();

      await press(tab('gifs'), 'ArrowRight');

      expect(tab('stickers')).toHaveFocus();
      expect(tab('gifs')).toHaveAttribute('aria-selected', 'true');
      expect(host.value()).toBe('gifs');
      expect(tabStops()).toEqual([tab('stickers')]);
    });

    it.each(['Enter', ' '])('selects the focused tab with %j', async (key) => {
      const host = await renderTabs((h) => h.activation.set('manual'));
      tab('gifs').focus();
      await press(tab('gifs'), 'ArrowRight');

      await press(tab('stickers'), key);

      expect(tab('stickers')).toHaveAttribute('aria-selected', 'true');
      expect(host.value()).toBe('stickers');
    });

    it('selects a clicked tab', async () => {
      const host = await renderTabs((h) => h.activation.set('manual'));

      tab('emoji').click();
      await view.fixture.whenStable();

      expect(host.value()).toBe('emoji');
    });

    it('gives the tab stop back to the selected tab once focus leaves the list', async () => {
      await renderTabs((h) => h.activation.set('manual'));
      tab('gifs').focus();
      await press(tab('gifs'), 'ArrowRight');

      fireEvent.focusOut(tab('stickers'), { relatedTarget: document.body });
      await view.fixture.whenStable();

      expect(tabStops()).toEqual([tab('gifs')]);
    });
  });

  it('selects the tab a caller sets through the value binding', async () => {
    const host = await renderTabs();

    host.value.set('emoji');
    await view.fixture.whenStable();

    expect(tab('emoji')).toHaveAttribute('aria-selected', 'true');
    expect(view.getByRole('tabpanel', { name: 'emoji' })).toBeVisible();
  });

  it('skips a disabled tab with the arrow keys and leaves it out of the tab order', async () => {
    await renderTabs((h) => h.disabledTab.set('stickers'));
    tab('gifs').focus();

    expect(tab('stickers')).toBeDisabled();
    await press(tab('gifs'), 'ArrowRight');

    expect(tab('emoji')).toHaveFocus();
    expect(tab('stickers')).toHaveAttribute('tabindex', '-1');
  });

  it('reaches a tab added after the list was first shown', async () => {
    const host = await renderTabs((h) => h.tabs.set(['gifs', 'emoji']));
    tab('gifs').focus();
    await press(tab('gifs'), 'ArrowRight');
    host.tabs.set(['gifs', 'stickers', 'emoji']);
    await view.fixture.whenStable();
    tab('gifs').focus();

    await press(tab('gifs'), 'ArrowRight');

    expect(tab('stickers')).toHaveFocus();
  });

  it('flips the arrow keys in a right-to-left layout', async () => {
    await renderTabs((h) => h.dir.set('rtl'));
    tab('gifs').focus();

    await press(tab('gifs'), 'ArrowLeft');
    expect(tab('stickers')).toHaveFocus();
    await press(tab('stickers'), 'ArrowRight');
    expect(tab('gifs')).toHaveFocus();
  });

  it('puts a panel in the tab order unless its content is focusable itself', async () => {
    await renderTabs();
    const panel = () => view.getByRole('tabpanel', { name: 'gifs' });
    expect(panel()).toHaveAttribute('tabindex', '0');

    view.fixture.componentInstance.focusable.set(false);
    await view.fixture.whenStable();

    expect(panel()).not.toHaveAttribute('tabindex');
  });

  describe('keeps one tab stop reachable', () => {
    it('on the first tab while nothing is selected', async () => {
      await renderTabs((h) => h.value.set(undefined));

      expect(tabStops()).toEqual([tab('gifs')]);
    });

    it('on the first enabled tab while the selected one is disabled', async () => {
      await renderTabs((h) => h.disabledTab.set('gifs'));

      expect(tabStops()).toEqual([tab('stickers')]);
    });

    it('on the first tab while the selected value names no tab', async () => {
      await renderTabs((h) => h.value.set('gone'));

      expect(tabStops()).toEqual([tab('gifs')]);
    });

    it('on the selected tab again once the focused tab is removed', async () => {
      const host = await renderTabs((h) => h.activation.set('manual'));
      tab('gifs').focus();
      await press(tab('gifs'), 'ArrowRight');

      host.tabs.set(['gifs', 'emoji']);
      await view.fixture.whenStable();

      expect(tabStops()).toEqual([tab('gifs')]);
    });
  });

  it('leaves arrow keys with a modifier to the browser', async () => {
    await renderTabs();
    tab('gifs').focus();

    for (const modifier of ['altKey', 'ctrlKey', 'metaKey']) {
      const event = new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
        [modifier]: true,
      });
      tab('gifs').dispatchEvent(event);
      await view.fixture.whenStable();

      expect(event.defaultPrevented).toBe(false);
      expect(tab('gifs')).toHaveFocus();
    }
  });

  it('treats a panel whose tab is not shown as plain content', async () => {
    await renderTabs();
    const orphan = view.getByText('No tab of its own');

    expect(orphan).not.toHaveAttribute('role');
    expect(orphan).not.toHaveAttribute('aria-labelledby');
    expect(orphan).not.toHaveAttribute('tabindex');
  });

  it('draws segmented pills by default', async () => {
    await renderTabs();
    const segmented = view.getByRole('tablist', { name: 'Picker type' });
    expect(segmented.className).not.toContain('border-b');
    expect(tab('gifs').className).toContain('rounded-');
  });

  it('draws an underlined strip with an accent bar on request', async () => {
    @Component({
      imports: [TrnTabs, TrnTabList, TrnTab],
      template: `
        <div trnTabs appearance="underline" value="a">
          <div trnTabList aria-label="Underlined">
            <button trnTab="a">A</button>
          </div>
        </div>
      `,
    })
    class UnderlineHostComponent {}

    const underline = await render(UnderlineHostComponent);
    const list = underline.getByRole('tablist', { name: 'Underlined' });
    const selected = within(list).getByRole('tab', { name: 'A' });
    expect(list.className).toContain('border-b');
    expect(selected.className).toContain('border-b-2');
    expect(selected.className).toContain(
      'aria-selected:border-[var(--trinity-accent)]',
    );
    expect(selected.className).not.toContain(
      'aria-selected:bg-[var(--trinity-state-selected-surface)]',
    );
    // Forced colours replace the accent, so the system selection colour marks the tab there.
    expect(selected.className).toContain(
      'forced-colors:aria-selected:border-b-[Highlight]',
    );
    // An edge-to-edge strip sits in a clipping scroller, so its focus ring is inset.
    expect(selected.className).toContain(
      'focus-visible:outline-offset-[calc(-1*var(--trinity-focus-ring-width))]',
    );
  });
});
