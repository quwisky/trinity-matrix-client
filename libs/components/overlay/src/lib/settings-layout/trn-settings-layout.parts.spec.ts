import { Component, signal } from '@angular/core';
import { render } from '@trinity/testing';
import { provideTrnIcons } from '@trinity/components/foundations';
import { afterEach, beforeEach } from 'vitest';
import { TrnSettingsGroupComponent } from './trn-settings-group.component';
import {
  TrnSettingsLayoutComponent,
  type TrnSettingsLayoutSection,
} from './trn-settings-layout.component';

const sections: readonly TrnSettingsLayoutSection[] = [
  { id: 'general', label: 'General', icon: 'settings', group: 'Basics' },
  { id: 'advanced', label: 'Advanced', icon: 'code', group: 'More' },
];

class FakeObserver {
  static instances: FakeObserver[] = [];
  readonly observed = new Set<Element>();
  disconnected = false;
  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    FakeObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.add(el);
  }
  unobserve(el: Element): void {
    this.observed.delete(el);
  }
  disconnect(): void {
    this.disconnected = true;
    this.observed.clear();
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  /** Report the headings whose ids are listed as intersecting, all others not. */
  report(visibleIds: readonly string[]): void {
    const entries = Array.from(this.observed).map(
      (target) =>
        ({
          target,
          isIntersecting: visibleIds.includes(target.id.replace('part-', '')),
        }) as IntersectionObserverEntry,
    );
    this.callback(entries, this as unknown as IntersectionObserver);
  }
  static get live(): FakeObserver {
    return FakeObserver.instances.filter((o) => !o.disconnected).at(-1)!;
  }
}

/** Read by the host's field initialisers: what the section and fragment are at first render. */
const partsStart: { section: string; part: string | null } = {
  section: 'general',
  part: null,
};

@Component({
  imports: [TrnSettingsLayoutComponent, TrnSettingsGroupComponent],
  template: `
    <trn-settings-layout
      title="Preferences"
      [sections]="sections"
      [selectedSection]="selected()"
      [initialPart]="initialPart()"
      [compact]="compact()"
      [directoryVisible]="!compact()"
      (sectionSelected)="selected.set($event)"
      (partSelected)="partSelected($event)"
    >
      @if (selected() === 'general') {
        @if (leading()) {
          <trn-settings-group />
        }
        <trn-settings-group title="Theme" />
        <trn-settings-group title="Messages" />
        <trn-settings-group title="Code blocks" />
        @if (late()) {
          <trn-settings-group title="Window" />
        }
      }
    </trn-settings-layout>
  `,
})
class PartsHostComponent {
  readonly sections = sections;
  readonly selected = signal<string | null>(partsStart.section);
  readonly initialPart = signal<string | null>(partsStart.part);
  readonly late = signal(false);
  readonly leading = signal(false);
  readonly compact = signal(false);
  readonly partSelected = vi.fn();
}

describe('TrnSettingsLayoutComponent parts', () => {
  const scrollTo = vi.fn();
  const order = ['theme', 'messages', 'code-blocks', 'window'];
  /** The scroll offset the fake layout gives a heading: 500px per part in document order. */
  const offsetOf = (id: string): number => order.indexOf(id) * 500;
  let reduceMotion = false;

  beforeEach(() => {
    FakeObserver.instances = [];
    scrollTo.mockReset();
    reduceMotion = false;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: Element) {
        const top = this.id.startsWith('part-')
          ? offsetOf(this.id.slice(5))
          : 0;
        return {
          top,
          bottom: top,
          left: 0,
          right: 0,
          width: 0,
          height: 0,
        } as DOMRect;
      },
    );
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: reduceMotion && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    Element.prototype.scrollTo = scrollTo;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const mount = async (
    start: { section?: string; part?: string } = {},
  ): Promise<{
    container: HTMLElement;
    host: PartsHostComponent;
    detail: HTMLElement;
    flush: () => Promise<void>;
  }> => {
    partsStart.section = start.section ?? 'general';
    partsStart.part = start.part ?? null;
    const result = await render(PartsHostComponent, {
      providers: [provideTrnIcons()],
    });
    const flush = async (): Promise<void> => {
      result.fixture.detectChanges();
      await result.fixture.whenStable();
      result.fixture.detectChanges();
    };
    await flush();
    return {
      container: result.container as HTMLElement,
      host: result.fixture.componentInstance,
      detail: result.container.querySelector<HTMLElement>(
        '[data-testid="settings-detail"]',
      )!,
      flush,
    };
  };

  const partRow = (c: HTMLElement, id: string): HTMLElement | null =>
    c.querySelector(`[data-testid="settings-part-${id}"]`);

  it('lists the parts under the selected section only', async () => {
    const { container, host, flush } = await mount();
    expect(
      Array.from(
        container.querySelectorAll('[data-testid^="settings-part-"]'),
      ).map((el) => el.getAttribute('data-testid')),
    ).toEqual([
      'settings-part-theme',
      'settings-part-messages',
      'settings-part-code-blocks',
    ]);
    const general = container.querySelector(
      '[data-testid="settings-tab-general"]',
    )!;
    expect(general.nextElementSibling?.querySelector('button')).toBe(
      partRow(container, 'theme'),
    );
    host.selected.set('advanced');
    await flush();
    expect(
      container.querySelectorAll('[data-testid^="settings-part-"]'),
    ).toHaveLength(0);
  });

  it('scrolls to the heading, moves focus, marks the row and emits on click', async () => {
    const { container, host, flush } = await mount();
    partRow(container, 'messages')!.click();
    await flush();
    const heading = container.querySelector<HTMLElement>('#part-messages')!;
    expect(scrollTo).toHaveBeenCalledOnce();
    expect(scrollTo.mock.contexts[0]).toBe(
      container.querySelector('[data-testid="settings-detail"]'),
    );
    expect(scrollTo).toHaveBeenCalledWith({
      top: offsetOf('messages'),
      behavior: 'smooth',
    });
    expect(document.activeElement).toBe(heading);
    expect(host.partSelected).toHaveBeenCalledWith('messages');
    const row = partRow(container, 'messages')!;
    expect(row).toHaveAttribute('aria-current', 'location');
    expect(row).toHaveClass('is-current');
    expect(partRow(container, 'theme')).not.toHaveAttribute('aria-current');
  });

  it('scrolls without animation under reduced motion', async () => {
    reduceMotion = true;
    const { container, flush } = await mount();
    partRow(container, 'messages')!.click();
    await flush();
    expect(scrollTo).toHaveBeenCalledWith({
      top: offsetOf('messages'),
      behavior: 'auto',
    });
  });

  it('follows the scroll: the observer picks the top-most visible heading', async () => {
    const { container, host, flush } = await mount();
    const observer = FakeObserver.live;
    expect(observer.options?.rootMargin).toBe('0px 0px -70% 0px');
    observer.report(['messages', 'code-blocks']);
    await flush();
    expect(partRow(container, 'messages')).toHaveAttribute(
      'aria-current',
      'location',
    );
    expect(partRow(container, 'code-blocks')).not.toHaveAttribute(
      'aria-current',
    );
    expect(host.partSelected).not.toHaveBeenCalled();
  });

  it('debounces the spy emission so the URL is not rewritten per frame', async () => {
    vi.useFakeTimers();
    const { host, detail, flush } = await mount();
    detail.scrollTop = 100;
    FakeObserver.live.report(['theme']);
    FakeObserver.live.report(['messages']);
    expect(host.partSelected).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    await flush();
    expect(host.partSelected).toHaveBeenCalledTimes(1);
    expect(host.partSelected).toHaveBeenCalledWith('messages');
  });

  it('selects the last part at the bottom of the page whatever the observer reports', async () => {
    const { container, detail, flush } = await mount();
    Object.defineProperty(detail, 'scrollHeight', { value: 1000 });
    Object.defineProperty(detail, 'clientHeight', { value: 400 });
    detail.scrollTop = 600;
    detail.dispatchEvent(new Event('scroll'));
    await flush();
    expect(partRow(container, 'code-blocks')).toHaveAttribute(
      'aria-current',
      'location',
    );
    FakeObserver.live.report(['messages']);
    await flush();
    expect(partRow(container, 'code-blocks')).toHaveAttribute(
      'aria-current',
      'location',
    );
  });

  it('highlights the first part and clears the fragment back at the top', async () => {
    vi.useFakeTimers();
    const { container, host, detail, flush } = await mount();
    detail.scrollTop = 100;
    FakeObserver.live.report(['messages']);
    vi.advanceTimersByTime(300);
    expect(host.partSelected).toHaveBeenLastCalledWith('messages');
    detail.scrollTop = 0;
    FakeObserver.live.report(['theme']);
    vi.advanceTimersByTime(300);
    await flush();
    expect(partRow(container, 'theme')).toHaveAttribute(
      'aria-current',
      'location',
    );
    expect(host.partSelected).toHaveBeenLastCalledWith(null);
  });

  it('scrolls to the initial part once it has rendered', async () => {
    const { host, flush } = await mount({ part: 'code-blocks' });
    expect(scrollTo).toHaveBeenCalledOnce();
    expect(scrollTo.mock.calls[0]?.[0].top).toBe(offsetOf('code-blocks'));
    expect(host.partSelected).toHaveBeenCalledWith('code-blocks');
    await flush();
  });

  it('opens at the top and asks the host to clear an unknown initial part', async () => {
    vi.useFakeTimers();
    const { host, detail } = await mount({ part: 'nope' });
    expect(host.partSelected).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(detail.scrollTop).toBe(0);
    expect(host.partSelected).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('keeps a deep link pending for a group that registers late', async () => {
    vi.useFakeTimers();
    const { host, flush } = await mount({ part: 'window' });
    vi.advanceTimersByTime(300);
    expect(host.partSelected).not.toHaveBeenCalled();
    host.late.set(true);
    await flush();
    expect(scrollTo.mock.calls[0]?.[0].top).toBe(offsetOf('window'));
    vi.advanceTimersByTime(1500);
    expect(host.partSelected).toHaveBeenCalledExactlyOnceWith('window');
  });

  it('clears a fragment on a section that has no parts', async () => {
    vi.useFakeTimers();
    const { host } = await mount({ section: 'advanced', part: 'theme' });
    vi.advanceTimersByTime(1500);
    expect(host.partSelected).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('does not write the old part onto a new section from a queued spy emit', async () => {
    vi.useFakeTimers();
    const { host, detail, flush } = await mount();
    detail.scrollTop = 100;
    FakeObserver.live.report(['messages']);
    host.selected.set('advanced');
    await flush();
    vi.advanceTimersByTime(1000);
    expect(host.partSelected).not.toHaveBeenCalled();
  });

  it('starts following the scroll again after a click and an immediate section switch', async () => {
    const { container, host, detail, flush } = await mount();
    partRow(container, 'messages')!.click();
    host.selected.set('advanced');
    await flush();
    host.selected.set('general');
    await flush();
    detail.scrollTop = 100;
    FakeObserver.live.report(['code-blocks']);
    await flush();
    expect(partRow(container, 'code-blocks')).toHaveAttribute(
      'aria-current',
      'location',
    );
  });

  it('drops a pending scroll target when the section changes', async () => {
    const { host, detail, flush } = await mount({
      section: 'advanced',
      part: 'code-blocks',
    });
    host.selected.set('general');
    await flush();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(detail.scrollTop).toBe(0);
  });

  it('renders a labelled chip row of links when compact', async () => {
    const { container, host, flush } = await mount();
    host.compact.set(true);
    await flush();
    const row = container.querySelector('nav[aria-label="Parts of General"]')!;
    const links = Array.from(row.querySelectorAll('a'));
    expect(links.map((a) => a.textContent?.trim())).toEqual([
      'Theme',
      'Messages',
      'Code blocks',
    ]);
    FakeObserver.live.report(['messages']);
    await flush();
    expect(links[1]).toHaveAttribute('aria-current', 'location');
    expect(links[0]).not.toHaveAttribute('aria-current');
    links[2]!.click();
    await flush();
    expect(scrollTo.mock.lastCall?.[0].top).toBe(offsetOf('code-blocks'));
  });

  it('scrolls the content column itself, clear of the sticky chip row, when compact', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { container, host, detail, flush } = await mount();
    host.compact.set(true);
    await flush();
    const row = container.querySelector<HTMLElement>(
      '.settings-layout__chips',
    )!;
    Object.defineProperty(row, 'offsetHeight', { value: 44 });
    row.querySelectorAll('a')[2]!.click();
    await flush();
    expect(detail.style.scrollPaddingTop).toBe('44px');
    expect(scrollTo).toHaveBeenCalledWith({
      top: offsetOf('code-blocks') - 44,
      behavior: 'smooth',
    });
    expect(scrollTo.mock.contexts[0]).toBe(detail);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('keeps no scroll padding when the chip row is not shown', async () => {
    const { container, host, detail, flush } = await mount();
    host.compact.set(true);
    await flush();
    container
      .querySelectorAll<HTMLElement>('.settings-layout__chips a')[1]!
      .click();
    host.compact.set(false);
    await flush();
    partRow(container, 'messages')!.click();
    expect(detail.style.scrollPaddingTop).toBe('');
  });

  it('has no part current at the top while an untitled block leads the section', async () => {
    const { container, host, detail, flush } = await mount();
    host.leading.set(true);
    await flush();
    detail.scrollTop = 0;
    FakeObserver.live.report([]);
    await flush();
    expect(container.querySelector('[aria-current="location"]')).toBeNull();
  });

  it('lets an open popover trigger take Escape before going back', async () => {
    const backRequested = vi.fn();
    const { container } = await render(TrnSettingsLayoutComponent, {
      inputs: {
        title: 'Preferences',
        sections,
        selectedSection: 'general',
        compact: true,
        directoryVisible: false,
      },
      on: { backRequested },
      providers: [provideTrnIcons()],
    });
    const trigger = document.createElement('button');
    trigger.setAttribute('aria-expanded', 'true');
    container.querySelector('.settings-layout__column')!.append(trigger);
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(backRequested).not.toHaveBeenCalled();
  });
});

const solo = { compact: false };

@Component({
  imports: [TrnSettingsLayoutComponent, TrnSettingsGroupComponent],
  template: `
    <trn-settings-layout
      title="Preferences"
      [sections]="sections"
      selectedSection="general"
      [compact]="compact"
      [directoryVisible]="!compact"
    >
      <trn-settings-group title="Only group" />
    </trn-settings-layout>
  `,
})
class SoloGroupHostComponent {
  readonly sections = sections;
  readonly compact = solo.compact;
}

describe('TrnSettingsLayoutComponent with a single group', () => {
  const mountSolo = async (compact: boolean): Promise<HTMLElement> => {
    solo.compact = compact;
    const { fixture, container } = await render(SoloGroupHostComponent, {
      providers: [provideTrnIcons()],
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return container as HTMLElement;
  };

  it('offers no part rows for one group', async () => {
    const container = await mountSolo(false);
    expect(container.querySelector('#part-only-group')).toBeTruthy();
    expect(
      container.querySelectorAll('[data-testid^="settings-part-"]'),
    ).toHaveLength(0);
  });

  it('offers no chips for one group on compact', async () => {
    const container = await mountSolo(true);
    expect(container.querySelector('#part-only-group')).toBeTruthy();
    expect(container.querySelector('.settings-layout__chips')).toBeNull();
  });
});
