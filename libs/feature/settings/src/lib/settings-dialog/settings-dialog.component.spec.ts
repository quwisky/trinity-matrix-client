import { TestBed } from '@angular/core/testing';
import { BUILD_INFO } from '@trinity/platform-native';
import { TrnDialogRef } from '@trinity/components/overlay';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      Array.from(root.querySelectorAll('.settings-layout__group'), (item) =>
        item.textContent?.trim(),
      ),
    ).toEqual(['Preferences']);
    input('no matching section');
    expect(root.querySelectorAll('[data-trn-settings-section]')).toHaveLength(
      0,
    );
    expect(root.querySelectorAll('.settings-layout__group')).toHaveLength(0);
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
