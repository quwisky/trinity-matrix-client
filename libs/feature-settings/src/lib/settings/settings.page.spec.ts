import { Location } from '@angular/common';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, type Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './settings.page';

// A trivial routed stand-in for each section sub-page, so the shell can be tested
// without pulling in the sections' SDK-backed services.
@Component({ selector: 'trn-stub-section', template: 'section' })
class StubSectionComponent {}

const SECTIONS = ['profile', 'appearance', 'devices', 'gifs', 'experimental'];

const ROUTES: Routes = [
  {
    path: 'settings',
    component: SettingsPage,
    children: SECTIONS.map((path) => ({
      path,
      component: StubSectionComponent,
    })),
  },
];

/**
 * Stub `matchMedia` so the shell reads a deterministic wide/narrow layout, and
 * capture the change handler so a test can simulate a resize via `fireChange`.
 */
function stubMatchMedia(wide: boolean): {
  fireChange: (matches: boolean) => void;
  removeListener: ReturnType<typeof vi.fn>;
} {
  let handler: ((event: MediaQueryListEvent) => void) | undefined;
  const removeListener = vi.fn();
  const mql = {
    matches: wide,
    addEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => {
      handler = fn;
    },
    removeEventListener: removeListener,
  };
  window.matchMedia = vi.fn().mockReturnValue(mql as unknown as MediaQueryList);
  return {
    fireChange: (matches: boolean) => {
      mql.matches = matches;
      handler?.({ matches } as MediaQueryListEvent);
    },
    removeListener,
  };
}

/** Let any queued async navigation (the redirect effect) settle. */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve));

async function harnessAt(url: string): Promise<{
  harness: RouterTestingHarness;
  shell: SettingsPage;
  router: Router;
}> {
  TestBed.configureTestingModule({ providers: [provideRouter(ROUTES)] });
  const harness = await RouterTestingHarness.create();
  const shell = await harness.navigateByUrl('/settings', SettingsPage);
  if (url !== '/settings') {
    await harness.navigateByUrl(url);
    harness.detectChanges();
  }
  return { harness, shell, router: TestBed.inject(Router) };
}

/** Poll the router until it reaches `url` (the wide-layout redirect is async). */
async function settle(router: Router, url: string): Promise<string> {
  for (let i = 0; i < 30 && router.url !== url; i++) {
    await new Promise((resolve) => setTimeout(resolve));
  }
  return router.url;
}

describe('SettingsPage (shell)', () => {
  const original = window.matchMedia;
  afterEach(() => {
    window.matchMedia = original;
  });

  it('renders a submenu link for every section', async () => {
    stubMatchMedia(false); // narrow: the index stays on the list
    const { harness } = await harnessAt('/settings');
    const el = harness.fixture.nativeElement as HTMLElement;

    expect(el.querySelectorAll('[data-testid^="settings-nav-"]').length).toBe(
      5,
    );
    for (const path of SECTIONS) {
      expect(
        el.querySelector(`[data-testid="settings-nav-${path}"]`),
      ).not.toBeNull();
    }
  });

  it('keeps the category list at the index on the narrow layout', async () => {
    stubMatchMedia(false);
    const { shell, router } = await harnessAt('/settings');
    await flush(); // a stray narrow redirect (regression) would land here and fail

    expect(router.url).toBe('/settings');
    expect(shell.sectionActive()).toBe(false);
  });

  it('auto-selects the first section on the wide layout', async () => {
    stubMatchMedia(true); // wide: the empty index redirects into the first section
    const { router } = await harnessAt('/settings');

    expect(await settle(router, '/settings/profile')).toBe('/settings/profile');
  });

  it('auto-selects the first section when the layout grows to wide', async () => {
    const media = stubMatchMedia(false); // start narrow: index on the list
    const { harness, router } = await harnessAt('/settings');
    expect(router.url).toBe('/settings');

    media.fireChange(true); // resize past the breakpoint
    harness.detectChanges(); // run the effect that reacts to wide()

    expect(await settle(router, '/settings/profile')).toBe('/settings/profile');
  });

  it('does not force a route change when the layout shrinks to narrow', async () => {
    const media = stubMatchMedia(true); // wide: lands on the first section
    const { harness, router } = await harnessAt('/settings');
    expect(await settle(router, '/settings/profile')).toBe('/settings/profile');

    media.fireChange(false); // shrink to narrow while a section is open
    harness.detectChanges();
    await flush();

    // Narrow only changes the layout (single-pane), never the open section.
    expect(router.url).toBe('/settings/profile');
  });

  it('removes its matchMedia listener when destroyed', async () => {
    const media = stubMatchMedia(false);
    const { harness } = await harnessAt('/settings');

    harness.fixture.destroy();

    expect(media.removeListener).toHaveBeenCalled();
  });

  it('marks the current section link active and exposes aria-current', async () => {
    stubMatchMedia(true);
    const { harness } = await harnessAt('/settings/appearance');
    const el = harness.fixture.nativeElement as HTMLElement;

    const active = el.querySelector('[data-testid="settings-nav-appearance"]');
    const other = el.querySelector('[data-testid="settings-nav-profile"]');
    expect(active?.classList.contains('settings__item--active')).toBe(true);
    expect(active?.getAttribute('aria-current')).toBe('page');
    expect(other?.classList.contains('settings__item--active')).toBe(false);
    expect(other?.getAttribute('aria-current')).toBeNull();
  });

  it('does not redirect a directly-opened section on the wide layout', async () => {
    stubMatchMedia(true); // wide, but a section is deep-linked from the start
    TestBed.configureTestingModule({ providers: [provideRouter(ROUTES)] });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/settings/devices'); // shell constructs here
    const router = TestBed.inject(Router);

    // The effect must read the URL (not the not-yet-activated child route) and leave
    // the deep-linked section put, rather than hijacking it to the first section.
    expect(await settle(router, '/settings/devices')).toBe('/settings/devices');
  });

  it('marks a section active when its detail is open', async () => {
    stubMatchMedia(false);
    const { harness, shell } = await harnessAt('/settings/appearance');

    expect(shell.sectionActive()).toBe(true);
    const el = harness.fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.settings--detail')).not.toBeNull();
  });

  it('leaves settings via history when the header back button is clicked at the index', async () => {
    stubMatchMedia(false);
    const { harness } = await harnessAt('/settings');
    const back = vi
      .spyOn(TestBed.inject(Location), 'back')
      .mockImplementation(() => undefined);

    // Click the real button to exercise the (click)/aria-label template wiring.
    const el = harness.fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>(
      'header button[aria-label=Back]',
    )?.click();

    expect(back).toHaveBeenCalled();
  });

  it('goes up to the category list from a section on the narrow layout', async () => {
    stubMatchMedia(false);
    const { harness, router } = await harnessAt('/settings/appearance');
    const back = vi.spyOn(TestBed.inject(Location), 'back');

    const el = harness.fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>(
      'header button[aria-label=Back]',
    )?.click();

    // Deterministic "up": routes to the list (history may not hold it), not back().
    expect(await settle(router, '/settings')).toBe('/settings');
    expect(back).not.toHaveBeenCalled();
  });

  it('leaves settings via history from a section on the wide layout', async () => {
    stubMatchMedia(true);
    const { harness } = await harnessAt('/settings/appearance');
    const back = vi
      .spyOn(TestBed.inject(Location), 'back')
      .mockImplementation(() => undefined);

    const el = harness.fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>(
      'header button[aria-label=Back]',
    )?.click();

    // Desktop: section links replace history, so Back exits through history rather
    // than routing "up" — one press leaves settings without retracing sections.
    expect(back).toHaveBeenCalled();
  });
});
