import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApplicationRef, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TrnDialogService } from '../dialog/trn-dialog.service';
import { render } from '@trinity/testing';
import { provideTrnIcons } from '@trinity/components/foundations';
import { afterEach, beforeEach, expectTypeOf } from 'vitest';
import { TrnSettingsGroupComponent } from './trn-settings-group.component';
import {
  TrnSettingsLayoutComponent,
  type TrnSettingsLayoutSection,
} from './trn-settings-layout.component';

const sections: readonly TrnSettingsLayoutSection[] = [
  { id: 'general', label: 'General', icon: 'settings', group: 'Basics' },
  { id: 'advanced', label: 'Advanced', icon: 'code', group: 'More' },
];

@Component({
  imports: [TrnSettingsLayoutComponent],
  template: `
    <trn-settings-layout
      title="Preferences"
      [sections]="sections"
      [selectedSection]="selected()"
      [compact]="compact()"
      [directoryVisible]="directoryVisible()"
      (sectionSelected)="selected.set($event)"
    >
      <span settings-context>Context</span>
      <p settings-warning>Warning</p>
      <p settings-directory-header>Directory controls</p>
      <p settings-nav-footer>Build 1</p>
      <h2>General</h2>
    </trn-settings-layout>
  `,
})
class SettingsLayoutHostComponent {
  readonly sections = sections;
  readonly selected = signal<string | null>('general');
  readonly compact = signal(false);
  readonly directoryVisible = signal(true);
}

describe('TrnSettingsLayoutComponent', () => {
  it('keeps compact section navigation with the directory hidden', async () => {
    const { container, getByRole } = await render(TrnSettingsLayoutComponent, {
      inputs: {
        title: 'System status',
        sections,
        selectedSection: 'general',
        compact: true,
        directoryVisible: false,
      },
      providers: [provideTrnIcons()],
    });
    expect(getByRole('button', { name: 'Back to sections' })).toBeTruthy();
    expect(container.querySelector('nav')).toHaveClass('settings-pane--hidden');
  });

  describe('full-screen layer', () => {
    const css = readFileSync(
      join(import.meta.dirname, 'trn-settings-layout.component.scss'),
      'utf8',
    );
    const rule = (selector: string): string =>
      new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'u').exec(
        css,
      )?.[1] ?? '';

    it('puts the nav on the app ground and the content on the pane', async () => {
      const { container } = await render(SettingsLayoutHostComponent, {
        providers: [provideTrnIcons()],
      });
      expect(container.querySelector('.settings-layout__nav')).toBeTruthy();
      expect(container.querySelector('.settings-layout__content')).toBeTruthy();
      expect(container.querySelector('[trnoverlaysurface]')).toBeNull();
      const nav = rule('.settings-layout__nav');
      expect(nav).toContain('background: var(--trinity-surface-app)');
      expect(nav).toContain('flex: 0 0 35%');
      expect(nav).toContain('min-inline-size: 218px');
      const inner = rule('.settings-layout__nav-inner');
      expect(inner).toContain('inline-size: 192px');
      expect(inner).toContain('margin-inline-start: auto');
      expect(rule('.settings-layout__group-label')).toContain(
        'text-transform: uppercase',
      );
      expect(rule('.settings-layout__content')).toContain(
        'background: var(--trinity-surface-pane)',
      );
      expect(rule('.settings-layout__column')).toContain(
        'max-inline-size: 740px',
      );
      const title = rule('.settings-layout__column h1');
      expect(title).toContain('font-size: var(--trinity-text-lg)');
      expect(title).toContain('font-weight: 700');
    });

    it('renders the context and warning before the section title', async () => {
      const { container } = await render(SettingsLayoutHostComponent, {
        providers: [provideTrnIcons()],
      });
      const column = container.querySelector('.settings-layout__column')!;
      const order = Array.from(column.children).map(
        (el) =>
          el.getAttribute('settings-context') ??
          el.getAttribute('settings-warning') ??
          el.tagName,
      );
      expect(order.slice(0, 3)).toEqual(['', '', 'H1']);
      expect(column.children[0]?.textContent).toContain('Context');
      expect(column.children[1]?.textContent).toContain('Warning');
    });

    it('closes from a round close button with a hidden ESC caption', async () => {
      const closeRequested = vi.fn();
      const { getByRole, container } = await render(
        TrnSettingsLayoutComponent,
        {
          inputs: {
            title: 'Preferences',
            sections,
            selectedSection: 'general',
          },
          on: { closeRequested },
          providers: [provideTrnIcons()],
        },
      );
      const close = getByRole('button', { name: 'Close settings' });
      expect(
        container
          .querySelector('.settings-layout__close-caption')
          ?.getAttribute('aria-hidden'),
      ).toBe('true');
      expect(
        container.querySelector('.settings-layout__close-caption')?.textContent,
      ).toContain('ESC');
      close.click();
      expect(closeRequested).toHaveBeenCalledTimes(1);
    });

    it('leaves Escape to the dialog unless compact with a section open', async () => {
      const closeRequested = vi.fn();
      const backRequested = vi.fn();
      const { container, fixture } = await render(TrnSettingsLayoutComponent, {
        inputs: {
          title: 'Preferences',
          sections,
          selectedSection: 'general',
        },
        on: { closeRequested, backRequested },
        providers: [provideTrnIcons()],
      });
      const setInputs = (
        f: {
          componentRef: { setInput(n: string, v: unknown): void };
          detectChanges(): void;
        },
        values: Record<string, unknown>,
      ): void => {
        for (const [k, v] of Object.entries(values))
          f.componentRef.setInput(k, v);
        f.detectChanges();
      };
      const press = (): { reachedBody: boolean; prevented: boolean } => {
        const reached = vi.fn();
        document.body.addEventListener('keydown', reached);
        const event = new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        });
        container.querySelector('button')!.dispatchEvent(event);
        document.body.removeEventListener('keydown', reached);
        return {
          reachedBody: reached.mock.calls.length > 0,
          prevented: event.defaultPrevented,
        };
      };
      // Wide: the dialog's own Escape (and its guard) owns the close.
      expect(press()).toEqual({ reachedBody: true, prevented: false });
      // Compact with the directory showing: still the dialog's close.
      setInputs(fixture, {
        title: 'Preferences',
        sections,
        selectedSection: 'general',
        compact: true,
        directoryVisible: true,
      });
      expect(press().reachedBody).toBe(true);
      expect(backRequested).not.toHaveBeenCalled();
      // Compact with a section open: back to the list, and the dialog stays open.
      setInputs(fixture, {
        title: 'Preferences',
        sections,
        selectedSection: 'general',
        compact: true,
        directoryVisible: false,
      });
      expect(press()).toEqual({ reachedBody: false, prevented: true });
      expect(backRequested).toHaveBeenCalledTimes(1);
      expect(closeRequested).not.toHaveBeenCalled();
    });

    it('keeps a close button and heading on the compact list', async () => {
      const closeRequested = vi.fn();
      const { container, getByRole } = await render(
        TrnSettingsLayoutComponent,
        {
          inputs: {
            title: 'Preferences',
            sections,
            selectedSection: null,
            compact: true,
            directoryVisible: true,
          },
          on: { closeRequested },
          providers: [provideTrnIcons()],
        },
      );
      const nav = container.querySelector('nav')!;
      const close = getByRole('button', { name: 'Close settings' });
      expect(nav.contains(close)).toBe(true);
      expect(nav.querySelector('h1[data-settings-autofocus]')).toBeTruthy();
      expect(container.querySelectorAll('h1')).toHaveLength(1);
      expect(
        container.querySelectorAll('.settings-layout__close'),
      ).toHaveLength(1);
      close.click();
      expect(closeRequested).toHaveBeenCalledTimes(1);
    });

    it('names the close action and keeps the workspace test id', async () => {
      const { container, getByRole } = await render(
        TrnSettingsLayoutComponent,
        {
          inputs: {
            title: 'System status',
            sections,
            selectedSection: 'general',
            closeLabel: 'Close System status',
          },
          providers: [provideTrnIcons()],
        },
      );
      expect(getByRole('button', { name: 'Close System status' })).toBeTruthy();
      expect(
        container.querySelector('[data-testid="settings-workspace"]'),
      ).toBeTruthy();
    });
  });

  describe('inside the dialog stack', () => {
    @Component({
      imports: [TrnSettingsLayoutComponent],
      template: `<trn-settings-layout
        title="Preferences"
        [sections]="sections"
        selectedSection="general"
        (closeRequested)="closed = true"
      />`,
    })
    class LayerComponent {
      readonly sections = sections;
      closed = false;
    }

    @Component({ template: '<p>Inner overlay</p>' })
    class InnerComponent {}

    afterEach(() => TestBed.inject(TrnDialogService).closeAll());

    const escape = (): void => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          keyCode: 27,
          bubbles: true,
          cancelable: true,
        }),
      );
    };

    it('closes an inner overlay first, then asks the dismiss guard once', () => {
      const guard = vi.fn(() => false);
      const dialogs = TestBed.inject(TrnDialogService);
      dialogs.open(LayerComponent, {
        placement: 'fullscreen',
        dismissGuard: guard,
      });
      TestBed.inject(ApplicationRef).tick();
      dialogs.open(InnerComponent);
      TestBed.inject(ApplicationRef).tick();
      expect(document.querySelectorAll('.cdk-dialog-container')).toHaveLength(
        2,
      );

      escape();
      TestBed.inject(ApplicationRef).tick();
      expect(document.querySelectorAll('.cdk-dialog-container')).toHaveLength(
        1,
      );
      expect(guard).not.toHaveBeenCalled();

      escape();
      expect(guard).toHaveBeenCalledOnce();
      expect(dialogs.hasOpen()).toBe(true);
    });
  });

  it('publishes the domain-neutral section contract', () => {
    expectTypeOf<TrnSettingsLayoutSection>().toEqualTypeOf<{
      readonly id: string;
      readonly label: string;
      readonly icon: import('@trinity/components/foundations').TrnIconName;
      readonly group?: string;
    }>();
  });

  it('renders the projected context, warning, footer, and selected directory state', async () => {
    const { container } = await render(SettingsLayoutHostComponent, {
      providers: [provideTrnIcons()],
    });

    expect(container.querySelector('h1')?.textContent?.trim()).toBe(
      'Preferences',
    );
    expect(container.querySelector('nav')?.getAttribute('aria-label')).toBe(
      'Preferences sections',
    );
    expect(
      container.querySelector('nav [settings-directory-header]')?.textContent,
    ).toBe('Directory controls');
    expect(
      container.querySelector('[settings-context]')?.textContent,
    ).toContain('Context');
    expect(
      container.querySelector('[settings-warning]')?.textContent,
    ).toContain('Warning');
    expect(
      container.querySelector('[settings-nav-footer]')?.textContent,
    ).toContain('Build 1');
    expect(
      container.querySelector('[data-testid="settings-tab-general"]'),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('emits selection and uses the compact directory visibility for pane swapping', async () => {
    const { container, fixture } = await render(SettingsLayoutHostComponent, {
      providers: [provideTrnIcons()],
    });
    const host = fixture.componentInstance;

    container
      .querySelector<HTMLButtonElement>('[data-testid="settings-tab-advanced"]')
      ?.click();
    expect(host.selected()).toBe('advanced');

    host.directoryVisible.set(false);
    fixture.detectChanges();
    expect(
      container
        .querySelector<HTMLElement>('[data-testid="settings-directory"]')
        ?.classList.contains('settings-pane--hidden'),
    ).toBe(false);

    host.compact.set(true);
    host.directoryVisible.set(true);
    fixture.detectChanges();
    expect(
      container
        .querySelector<HTMLElement>('[data-testid="settings-detail"]')
        ?.classList.contains('settings-pane--hidden'),
    ).toBe(true);
    expect(
      container.querySelector('[data-testid="settings-mobile-back"]'),
    ).toBeNull();

    host.directoryVisible.set(false);
    fixture.detectChanges();
    expect(
      container
        .querySelector<HTMLElement>('[data-testid="settings-detail"]')
        ?.classList.contains('settings-pane--hidden'),
    ).toBe(false);
    expect(
      container
        .querySelector<HTMLElement>('[data-testid="settings-directory"]')
        ?.classList.contains('settings-pane--hidden'),
    ).toBe(true);
    expect(
      container.querySelector('[data-testid="settings-mobile-back"]'),
    ).toBeTruthy();
  });
});

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
  readonly compact = signal(false);
  readonly partSelected = vi.fn();
}

describe('TrnSettingsLayoutComponent parts', () => {
  const scrollIntoView = vi.fn();
  let reduceMotion = false;

  beforeEach(() => {
    FakeObserver.instances = [];
    scrollIntoView.mockReset();
    reduceMotion = false;
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: reduceMotion && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    Element.prototype.scrollIntoView = scrollIntoView;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView.mock.contexts[0]).toBe(heading);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'start',
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
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: 'auto',
      block: 'start',
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
    const { container, host, flush } = await mount({ part: 'code-blocks' });
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView.mock.contexts[0]).toBe(
      container.querySelector('#part-code-blocks'),
    );
    expect(host.partSelected).toHaveBeenCalledWith('code-blocks');
    await flush();
  });

  it('opens at the top and asks the host to clear an unknown initial part', async () => {
    vi.useFakeTimers();
    const { host, detail } = await mount({ part: 'nope' });
    expect(host.partSelected).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(detail.scrollTop).toBe(0);
    expect(host.partSelected).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('keeps a deep link pending for a group that registers late', async () => {
    vi.useFakeTimers();
    const { container, host, flush } = await mount({ part: 'window' });
    vi.advanceTimersByTime(300);
    expect(host.partSelected).not.toHaveBeenCalled();
    host.late.set(true);
    await flush();
    expect(scrollIntoView.mock.contexts[0]).toBe(
      container.querySelector('#part-window'),
    );
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
    expect(scrollIntoView).not.toHaveBeenCalled();
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
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(
      container.querySelector('#part-code-blocks'),
    );
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
