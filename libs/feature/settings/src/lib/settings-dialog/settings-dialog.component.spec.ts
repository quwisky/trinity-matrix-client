import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { within } from '@testing-library/dom';
import { BUILD_INFO, FeatureFlagsService } from '@trinity/platform-native';
import { TrnDialogRef, TrnSettingsParts } from '@trinity/components/overlay';
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

  it('renders a section inside the layout, so its groups register as parts', async () => {
    TestBed.overrideProvider(FeatureFlagsService, {
      useValue: { virtualTimeline: signal(false), setVirtualTimeline: vi.fn() },
    });
    const fixture = TestBed.createComponent(SettingsDialogComponent);
    fixture.componentRef.setInput('initialSection', 'experimental');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const group = fixture.debugElement.query(By.css('trn-settings-group'));
    expect(group).not.toBeNull();
    const registry = group.injector.get(TrnSettingsParts, null);
    expect(registry?.parts().map((part) => part.id)).toEqual(['experimental']);
    fixture.destroy();
  });

  it('renders the accessible settings directory and closes explicitly', () => {
    const fixture = TestBed.createComponent(SettingsDialogComponent);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('h1')?.textContent).toContain('Settings');
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
});
