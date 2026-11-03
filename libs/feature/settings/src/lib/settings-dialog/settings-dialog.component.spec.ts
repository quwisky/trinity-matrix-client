import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { within } from '@testing-library/dom';
import { WorkspaceBackService } from '@trinity/application/workspace';
import {
  RELEASE_NOTES,
  WHATS_NEW_LAUNCHER,
} from '@trinity/data-access/whats-new';
import { BUILD_INFO, FeatureFlagsService } from '@trinity/platform-native';
import {
  TrnDialogRef,
  TrnSettingsParts,
  TrnSurfaceService,
} from '@trinity/components/overlay';
import { Location } from '@angular/common';
import { provideLocationMocks } from '@angular/common/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matchingSettingsSections } from '../settings-sections';
import { SettingsDialogComponent } from './settings-dialog.component';

describe('SettingsDialogComponent', () => {
  const close = vi.fn();

  beforeEach(() => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    TestBed.configureTestingModule({
      imports: [SettingsDialogComponent],
      providers: [
        {
          provide: BUILD_INFO,
          useValue: { version: '1.0.0', commit: 'abc1234' },
        },
        { provide: TrnDialogRef, useValue: { close } },
      ],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('keeps Log out out of the navigation', () => {
    const fixture = TestBed.createComponent(SettingsDialogComponent);
    fixture.detectChanges();
    const nav = (fixture.nativeElement as HTMLElement).querySelector('nav')!;
    expect(within(nav).queryByRole('button', { name: /log out/i })).toBeNull();
  });

  it('filters groups, reports no matches and clears without closing', async () => {
    const fixture = TestBed.createComponent(SettingsDialogComponent);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const search = root.querySelector<HTMLInputElement>(
      'input[type="search"]',
    )!;
    const input = (value: string): void => {
      search.value = value;
      search.dispatchEvent(new Event('input', { bubbles: true }));
      fixture.detectChanges();
    };
    input('preferences');
    expect(
      Array.from(root.querySelectorAll('[data-trn-settings-section]'), (item) =>
        item.textContent?.trim(),
      ),
    ).toEqual(['Appearance', 'Notifications', 'Privacy']);
    expect(
      Array.from(
        root.querySelectorAll('.settings-layout__group-label'),
        (item) => item.textContent?.trim(),
      ),
    ).toEqual(['Preferences']);
    input('no matching section');
    expect(root.querySelectorAll('[data-trn-settings-section]')).toHaveLength(
      0,
    );
    expect(root.querySelectorAll('.settings-layout__group-label')).toHaveLength(
      0,
    );
    expect(root.querySelector('[role="status"]')?.textContent).toContain(
      '0 sections found',
    );
    expect(root.textContent).toContain('No sections found.');
    root
      .querySelector<HTMLButtonElement>('[aria-label="Clear search"]')!
      .click();
    fixture.detectChanges();
    expect(search.value).toBe('');
    expect(root.querySelectorAll('[data-trn-settings-section]')).toHaveLength(
      14,
    );
    input('   ');
    expect(root.querySelectorAll('[data-trn-settings-section]')).toHaveLength(
      14,
    );
    expect(close).not.toHaveBeenCalled();
    fixture.destroy();
    const reopened = TestBed.createComponent(SettingsDialogComponent);
    reopened.detectChanges();
    expect(
      (reopened.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
        'input[type="search"]',
      )!.value,
    ).toBe('');
  });

  it('opens the section of a part result and hands the part to the layout', () => {
    const fixture = TestBed.createComponent(SettingsDialogComponent);
    fixture.detectChanges();
    const dialog = fixture.componentInstance;
    const [result] = matchingSettingsSections('code');

    dialog.openResult(result);
    expect(dialog.selectedPath()).toBe('appearance');
    expect(dialog.partTarget()).toBe('code-blocks');

    // Picking the same part again after scrolling elsewhere must scroll again.
    dialog.partTarget.set('timeline');
    dialog.openResult(result);
    expect(dialog.partTarget()).toBe('code-blocks');

    // A plain section pick drops the part.
    dialog.selectSection('privacy');
    expect(dialog.partTarget()).toBeNull();
    fixture.destroy();
  });

  it('titles the page with the open section, not with Settings', async () => {
    TestBed.overrideProvider(FeatureFlagsService, {
      useValue: {
        virtualTimeline: signal(false),
        setVirtualTimeline: vi.fn(),
        deferMediaWhileScrolling: signal(false),
        setDeferMediaWhileScrolling: vi.fn(),
        flingPlaceholders: signal(false),
        setFlingPlaceholders: vi.fn(),
      },
    });
    const fixture = TestBed.createComponent(SettingsDialogComponent);
    fixture.componentRef.setInput('initialSection', 'experimental');
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const headings = root.querySelectorAll('h1');
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent?.trim()).toBe('Experimental');
    expect(root.querySelector('nav')?.getAttribute('aria-label')).toBe(
      'Settings sections',
    );
    fixture.destroy();
  });

  it('renders a section inside the layout, so its groups register as parts', async () => {
    TestBed.overrideProvider(FeatureFlagsService, {
      useValue: {
        virtualTimeline: signal(false),
        setVirtualTimeline: vi.fn(),
        deferMediaWhileScrolling: signal(false),
        setDeferMediaWhileScrolling: vi.fn(),
        flingPlaceholders: signal(false),
        setFlingPlaceholders: vi.fn(),
      },
    });
    const fixture = TestBed.createComponent(SettingsDialogComponent);
    fixture.componentRef.setInput('initialSection', 'experimental');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const group = fixture.debugElement.query(By.css('trn-settings-group'));
    expect(group).not.toBeNull();
    const registry = group.injector.get(TrnSettingsParts, null);
    expect(registry).not.toBeNull();
    fixture.destroy();
  });

  it('steps a phone sheet back from a section to the list on Back, then lets it close', async () => {
    vi.stubGlobal('innerWidth', 390);
    const fixture = TestBed.createComponent(SettingsDialogComponent);
    fixture.detectChanges();
    const dialog = fixture.componentInstance;
    const back = TestBed.inject(WorkspaceBackService);
    // With the list showing, Settings has no step of its own; the opener closes it.
    expect(back.hasActive()).toBe(false);

    dialog.selectSection('appearance');
    fixture.detectChanges();
    const outcome = await firstValueFrom(back.back());

    expect(outcome.kind).toBe('dismissed');
    expect(dialog.selectedPath()).toBeNull();
    expect(close).not.toHaveBeenCalled();
    expect(back.hasActive()).toBe(false);
    fixture.destroy();
  });

  it('renders the accessible settings directory and closes explicitly', () => {
    const fixture = TestBed.createComponent(SettingsDialogComponent);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('h1')?.textContent).toContain('Profile');
    expect(root.querySelector('nav')?.getAttribute('aria-label')).toBe(
      'Settings sections',
    );
    expect(
      root.querySelectorAll('[data-testid^="settings-nav-"]'),
    ).toHaveLength(14);

    root
      .querySelector<HTMLButtonElement>('[data-testid="close-settings"]')
      ?.click();
    expect(close).toHaveBeenCalledOnce();
  });

  describe("What's new link", () => {
    const showAll = vi.fn();
    const notes = [
      { version: '1.0.0', date: '2026-01-01', sections: { added: ['x'] } },
    ] as never;
    const open = (provide: unknown[]): HTMLElement => {
      TestBed.configureTestingModule({ providers: provide as never[] });
      const fixture = TestBed.createComponent(SettingsDialogComponent);
      fixture.detectChanges();
      return fixture.nativeElement as HTMLElement;
    };

    it("opens What's new from the footer", () => {
      const root = open([
        { provide: RELEASE_NOTES, useValue: notes },
        { provide: WHATS_NEW_LAUNCHER, useValue: { showAll } },
      ]);
      const button = within(root).getByRole('button', { name: "What's new" });
      expect(button.dataset['testid']).toBe('settings-whats-new');
      button.click();
      expect(showAll).toHaveBeenCalledOnce();
    });

    it("hides the What's new link when the build has no notes", () => {
      const root = open([
        { provide: RELEASE_NOTES, useValue: [] },
        { provide: WHATS_NEW_LAUNCHER, useValue: { showAll } },
      ]);
      expect(
        within(root).queryByRole('button', { name: "What's new" }),
      ).toBeNull();
    });

    it("hides the What's new link without a launcher", () => {
      const root = open([{ provide: RELEASE_NOTES, useValue: notes }]);
      expect(
        within(root).queryByRole('button', { name: "What's new" }),
      ).toBeNull();
    });
  });

  describe('phone sheet history', () => {
    let topmost = true;
    const closeTopmost = vi.fn();
    const MARK = 'trinitySettingsSection';

    const sheet = () => {
      vi.stubGlobal('innerWidth', 390);
      TestBed.configureTestingModule({
        providers: [
          provideLocationMocks(),
          {
            provide: TrnSurfaceService,
            useValue: { isTopmost: () => topmost, closeTopmost },
          },
        ],
      });
      const location = TestBed.inject(Location);
      location.go('/rooms/!a');
      const fixture = TestBed.createComponent(SettingsDialogComponent);
      fixture.detectChanges();
      return { fixture, dialog: fixture.componentInstance, location };
    };
    const markOf = (location: Location) =>
      (
        location.getState() as Record<
          string,
          { section: string; depth: number }
        > | null
      )?.[MARK] ?? null;

    beforeEach(() => {
      topmost = true;
    });

    it('gives a section a marked entry at the same URL, and Back pops it', () => {
      const { fixture, dialog, location } = sheet();
      dialog.selectSection('appearance');
      expect(location.path()).toBe('/rooms/!a');
      expect(markOf(location)).toMatchObject({
        section: 'appearance',
        depth: 1,
      });

      dialog.goBackOrClose();
      expect(dialog.selectedPath()).toBeNull();
      expect(markOf(location)).toBeNull();
      expect(close).not.toHaveBeenCalled();

      // Browser Back from a section steps to the list too; Forward re-opens it.
      dialog.selectSection('privacy');
      location.back();
      expect(dialog.selectedPath()).toBeNull();
      location.forward();
      expect(dialog.selectedPath()).toBe('privacy');
      fixture.destroy();
    });

    it('takes its entries off history when it closes, and only its own', () => {
      const { fixture, dialog, location } = sheet();
      dialog.selectSection('appearance');
      const historyGo = vi.spyOn(location, 'historyGo');
      fixture.destroy();
      expect(historyGo).toHaveBeenCalledWith(-1);

      // A sheet opened over another sheet's leftover entry ignores that mark.
      location.go('/rooms/!a', '', {
        [MARK]: { sheet: 'another', section: 'privacy', depth: 1 },
      });
      const next = TestBed.createComponent(SettingsDialogComponent);
      next.detectChanges();
      location.go('/rooms/!a');
      location.back();
      expect(next.componentInstance.selectedPath()).toBeNull();
      historyGo.mockClear();
      next.destroy();
      expect(historyGo).not.toHaveBeenCalled();
    });

    it('closes a dialog over it instead of changing section, and undoes the step either way', () => {
      const { fixture, dialog, location } = sheet();
      dialog.selectSection('appearance');
      topmost = false;
      // Back: put back with Forward.
      location.back();
      expect(closeTopmost).toHaveBeenCalledOnce();
      expect(dialog.selectedPath()).toBe('appearance');
      expect(markOf(location)).toMatchObject({ section: 'appearance' });

      // Forward from the list: put back with Back.
      topmost = true;
      location.back();
      expect(dialog.selectedPath()).toBeNull();
      topmost = false;
      closeTopmost.mockClear();
      location.forward();
      expect(closeTopmost).toHaveBeenCalledOnce();
      expect(dialog.selectedPath()).toBeNull();
      expect(markOf(location)).toBeNull();
      fixture.destroy();
    });

    it('undoes the step once when the dialog over it refuses to close', () => {
      const { fixture, dialog, location } = sheet();
      dialog.selectSection('appearance');
      topmost = false;
      location.back();
      location.back();
      // The second Back is a fresh step, taken while the dialog still covers the sheet.
      expect(closeTopmost).toHaveBeenCalledTimes(2);
      expect(dialog.selectedPath()).toBe('appearance');
      expect(markOf(location)).toMatchObject({ section: 'appearance' });
      fixture.destroy();
    });
  });
});
