import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProfileService,
  ThemeService,
  type ResolvedTheme,
  type ThemePreference,
  type UserProfile,
} from '@trinity/core';
import { SettingsPage } from './settings.page';

describe('SettingsPage', () => {
  const setPreference = vi.fn();
  const setDisplayName = vi.fn(() => of(undefined));
  const setAvatar = vi.fn(() => of(undefined));
  let preference: ReturnType<typeof signal<ThemePreference>>;
  let resolved: ReturnType<typeof signal<ResolvedTheme>>;
  let profile: ReturnType<typeof signal<UserProfile | null>>;

  const PROFILE: UserProfile = {
    userId: '@me:hs',
    displayName: 'Alice',
    avatarMxc: null,
    avatarUrl: null,
  };

  beforeEach(() => {
    setPreference.mockReset();
    setDisplayName.mockClear();
    setAvatar.mockClear();
    preference = signal<ThemePreference>('system');
    resolved = signal<ResolvedTheme>('dark');
    profile = signal<UserProfile | null>(PROFILE);
    TestBed.configureTestingModule({
      imports: [SettingsPage],
      providers: [
        {
          provide: ThemeService,
          useValue: { preference, resolved, setPreference },
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
      ],
    });
  });

  it('renders the appearance options bound to the current preference', () => {
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelectorAll('ion-radio').length).toBe(3);
    expect(el.querySelector('[data-testid=theme-system]')).not.toBeNull();
    const group = el.querySelector('ion-radio-group') as
      | (HTMLElement & { value: string })
      | null;
    expect(group?.value).toBe('system');
    expect(el.textContent).toContain('dark'); // resolved-theme note
  });

  it('applies the chosen theme on change', () => {
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();

    fixture.componentInstance.onThemeChange(
      new CustomEvent('ionChange', { detail: { value: 'light' } }),
    );

    expect(setPreference).toHaveBeenCalledWith('light');
  });

  it('renders the profile and seeds the editable name', () => {
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.textContent).toContain('Alice');
    expect(el.textContent).toContain('@me:hs');
    expect(fixture.componentInstance.nameDraft()).toBe('Alice'); // seeded by load()
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
