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
