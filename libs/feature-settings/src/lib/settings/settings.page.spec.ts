import { Location } from '@angular/common';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { By } from '@angular/platform-browser';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DevicesService,
  FeatureFlagsService,
  ProfileService,
  ThemeService,
  type ResolvedTheme,
  type ThemePreference,
  type UserProfile,
} from '@trinity/core';
import { HlmCheckbox } from '@trinity/helm/checkbox';
import { SettingsPage } from './settings.page';

describe('SettingsPage', () => {
  const setPreference = vi.fn();
  const setVirtualTimeline = vi.fn();
  const setDisplayName = vi.fn(() => of(undefined));
  const setAvatar = vi.fn(() => of(undefined));
  let preference: ReturnType<typeof signal<ThemePreference>>;
  let resolved: ReturnType<typeof signal<ResolvedTheme>>;
  let virtualTimeline: ReturnType<typeof signal<boolean>>;
  let profile: ReturnType<typeof signal<UserProfile | null>>;

  const PROFILE: UserProfile = {
    userId: '@me:hs',
    displayName: 'Alice',
    avatarMxc: null,
    avatarUrl: null,
  };

  beforeEach(() => {
    setPreference.mockReset();
    setVirtualTimeline.mockReset();
    setDisplayName.mockClear();
    setAvatar.mockClear();
    preference = signal<ThemePreference>('system');
    resolved = signal<ResolvedTheme>('dark');
    virtualTimeline = signal(false);
    profile = signal<UserProfile | null>(PROFILE);
    TestBed.configureTestingModule({
      imports: [SettingsPage],
      providers: [
        {
          provide: ThemeService,
          useValue: { preference, resolved, setPreference },
        },
        {
          provide: FeatureFlagsService,
          useValue: { virtualTimeline, setVirtualTimeline },
        },
        {
          provide: ProfileService,
          // load() reflects the current signal so a test can preset an empty profile.
          useValue: {
            profile,
            load: () => of(profile()),
            setDisplayName,
            setAvatar,
          },
        },
        // The embedded devices section needs these to construct.
        {
          provide: DevicesService,
          useValue: {
            devices: signal([]),
            list: () => of([]),
            connect: vi.fn(),
            disconnect: vi.fn(),
          },
        },
        // The devices section's "Verify a device" goes through EncryptionDialogService,
        // which injects the root-provided TrnDialogService — no test provider needed.
        // Real router providers — Location.back() (the shell back button) needs them.
        provideRouter([]),
      ],
    });
  });

  it('renders the appearance options bound to the current preference', () => {
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelectorAll('hlm-radio').length).toBe(3);
    expect(el.querySelector('[data-testid=theme-system]')).not.toBeNull();
    // The bound preference ('system') is reflected on the native radio input.
    const systemInput = el.querySelector<HTMLInputElement>(
      '[data-testid=theme-system] input',
    );
    expect(systemInput?.checked).toBe(true);
    expect(el.textContent).toContain('dark'); // resolved-theme note
  });

  it('navigates back via the shell header back button', () => {
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();
    const back = vi
      .spyOn(TestBed.inject(Location), 'back')
      .mockImplementation(() => undefined);

    const button = (
      fixture.nativeElement as HTMLElement
    ).querySelector<HTMLButtonElement>('header button[aria-label=Back]');
    button?.click();

    expect(back).toHaveBeenCalled();
  });

  it('applies the chosen theme on change', () => {
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();

    fixture.componentInstance.onThemeChange('light');

    expect(setPreference).toHaveBeenCalledWith('light');
  });

  it('reflects and toggles the virtualized-timeline flag', () => {
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    expect(
      el.querySelector('[data-testid=flag-virtual-timeline]'),
    ).not.toBeNull();
    const checkbox = fixture.debugElement.query(By.directive(HlmCheckbox));
    expect(checkbox.componentInstance.checked()).toBe(false); // off by default

    // The checkbox reflects the persisted signal.
    virtualTimeline.set(true);
    fixture.detectChanges();
    expect(checkbox.componentInstance.checked()).toBe(true);

    // Toggling emits checkedChange → the flag is persisted.
    checkbox.componentInstance.checkedChange.emit(false);
    expect(setVirtualTimeline).toHaveBeenCalledWith(false);
  });

  it('renders the profile and seeds the editable name', () => {
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.textContent).toContain('Alice');
    expect(el.textContent).toContain('@me:hs');
    expect(fixture.componentInstance.nameDraft()).toBe('Alice'); // seeded by load()
  });

  it('updates the draft name from a native input event', () => {
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    // The handler now reads a native <input>'s value (not an ionInput CustomEvent).
    cmp.onNameInput({ target: { value: 'Carol' } } as unknown as Event);

    expect(cmp.nameDraft()).toBe('Carol');
  });

  it('saves an edited display name', () => {
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    cmp.nameDraft.set('Bob');
    cmp.saveName();

    expect(setDisplayName).toHaveBeenCalledWith('Bob');
  });

  it('uploads a picked avatar file', () => {
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    const file = new File([new Uint8Array([1])], 'me.png', {
      type: 'image/png',
    });
    const input = document.createElement('input');
    Object.defineProperty(input, 'files', {
      value: [file],
      configurable: true,
    });

    cmp.onAvatarPicked({ target: input } as unknown as Event);

    expect(setAvatar).toHaveBeenCalledWith(file);
    expect(input.value).toBe(''); // reset for re-picking
  });

  it('rejects a non-image avatar file with an error', () => {
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    const file = new File(['x'], 'notes.txt', { type: 'text/plain' });
    const input = document.createElement('input');
    Object.defineProperty(input, 'files', {
      value: [file],
      configurable: true,
    });

    cmp.onAvatarPicked({ target: input } as unknown as Event);

    expect(setAvatar).not.toHaveBeenCalled();
    expect(cmp.error()).toContain('image');
  });

  it('renders the user id when no display name is set', () => {
    profile.set({
      userId: '@me:hs',
      displayName: '',
      avatarMxc: null,
      avatarUrl: null,
    });
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('@me:hs');
    // The editable field is empty (not prefilled with the user id).
    expect(fixture.componentInstance.nameDraft()).toBe('');
  });
});
