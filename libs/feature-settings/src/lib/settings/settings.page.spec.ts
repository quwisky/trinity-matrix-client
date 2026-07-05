import { Location } from '@angular/common';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { By } from '@angular/platform-browser';
import { of } from 'rxjs';
import { render } from '@testing-library/angular';
import { MockComponent, MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileService, type UserProfile } from '@trinity/data-access-profile';
import {
  FeatureFlagsService,
  ThemeService,
  type ResolvedTheme,
  type ThemePreference,
} from '@trinity/platform-native';
import { HlmCheckbox } from '@trinity/helm/checkbox';
import { DevicesSectionComponent } from '../devices/devices-section.component';
import { SettingsPage } from './settings.page';

describe('SettingsPage', () => {
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
    preference = signal<ThemePreference>('system');
    resolved = signal<ResolvedTheme>('dark');
    virtualTimeline = signal(false);
    profile = signal<UserProfile | null>(PROFILE);
  });

  async function renderPage() {
    const result = await render(SettingsPage, {
      // The devices section is a stateful feature child (its own SDK-backed
      // service + dialog deps); mock it so the settings shell renders in isolation.
      imports: [MockComponent(DevicesSectionComponent)],
      providers: [
        MockProvider(ThemeService, { preference, resolved }),
        MockProvider(FeatureFlagsService, { virtualTimeline }),
        MockProvider(ProfileService, {
          profile,
          // load() reflects the current signal so a test can preset an empty profile.
          load: () => of(profile()!),
        }),
        // Real router providers — Location.back() (the shell back button) needs them.
        provideRouter([]),
      ],
    });
    const profileSvc = TestBed.inject(ProfileService);
    // The save actions return cold Observables the page feeds to runWithBusy.
    vi.mocked(profileSvc.setDisplayName).mockReturnValue(of(undefined));
    vi.mocked(profileSvc.setAvatar).mockReturnValue(of(undefined));
    return { ...result, profileSvc };
  }

  it('renders the appearance options bound to the current preference', async () => {
    const { container } = await renderPage();

    expect(container.querySelectorAll('hlm-radio').length).toBe(3);
    expect(
      container.querySelector('[data-testid=theme-system]'),
    ).not.toBeNull();
    // The bound preference ('system') is reflected on the native radio input.
    const systemInput = container.querySelector<HTMLInputElement>(
      '[data-testid=theme-system] input',
    );
    expect(systemInput?.checked).toBe(true);
    expect(container.textContent).toContain('dark'); // resolved-theme note
  });

  it('navigates back via the shell header back button', async () => {
    const { container } = await renderPage();
    const back = vi
      .spyOn(TestBed.inject(Location), 'back')
      .mockImplementation(() => undefined);

    const button = container.querySelector<HTMLButtonElement>(
      'header button[aria-label=Back]',
    );
    button?.click();

    expect(back).toHaveBeenCalled();
  });

  it('applies the chosen theme on change', async () => {
    const { fixture } = await renderPage();

    fixture.componentInstance.onThemeChange('light');

    expect(TestBed.inject(ThemeService).setPreference).toHaveBeenCalledWith(
      'light',
    );
  });

  it('reflects and toggles the virtualized-timeline flag', async () => {
    const { fixture, container } = await renderPage();

    expect(
      container.querySelector('[data-testid=flag-virtual-timeline]'),
    ).not.toBeNull();
    const checkbox = fixture.debugElement.query(By.directive(HlmCheckbox));
    expect(checkbox.componentInstance.checked()).toBe(false); // off by default

    // The checkbox reflects the persisted signal.
    virtualTimeline.set(true);
    fixture.detectChanges();
    expect(checkbox.componentInstance.checked()).toBe(true);

    // Toggling emits checkedChange → the flag is persisted.
    checkbox.componentInstance.checkedChange.emit(false);
    expect(
      TestBed.inject(FeatureFlagsService).setVirtualTimeline,
    ).toHaveBeenCalledWith(false);
  });

  it('renders the profile and seeds the editable name', async () => {
    const { fixture, container } = await renderPage();

    expect(container.textContent).toContain('Alice');
    expect(container.textContent).toContain('@me:hs');
    expect(fixture.componentInstance.nameDraft()).toBe('Alice'); // seeded by load()
  });

  it('updates the draft name from a native input event', async () => {
    const { fixture } = await renderPage();
    const cmp = fixture.componentInstance;

    // The handler now reads a native <input>'s value (not an ionInput CustomEvent).
    cmp.onNameInput({ target: { value: 'Carol' } } as unknown as Event);

    expect(cmp.nameDraft()).toBe('Carol');
  });

  it('saves an edited display name', async () => {
    const { fixture, profileSvc } = await renderPage();
    const cmp = fixture.componentInstance;

    cmp.nameDraft.set('Bob');
    cmp.saveName();

    expect(profileSvc.setDisplayName).toHaveBeenCalledWith('Bob');
  });

  it('uploads a picked avatar file', async () => {
    const { fixture, profileSvc } = await renderPage();
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

    expect(profileSvc.setAvatar).toHaveBeenCalledWith(file);
    expect(input.value).toBe(''); // reset for re-picking
  });

  it('rejects a non-image avatar file with an error', async () => {
    const { fixture, profileSvc } = await renderPage();
    const cmp = fixture.componentInstance;

    const file = new File(['x'], 'notes.txt', { type: 'text/plain' });
    const input = document.createElement('input');
    Object.defineProperty(input, 'files', {
      value: [file],
      configurable: true,
    });

    cmp.onAvatarPicked({ target: input } as unknown as Event);

    expect(profileSvc.setAvatar).not.toHaveBeenCalled();
    expect(cmp.error()).toContain('image');
  });

  it('renders the user id when no display name is set', async () => {
    profile.set({
      userId: '@me:hs',
      displayName: '',
      avatarMxc: null,
      avatarUrl: null,
    });
    const { fixture, container } = await renderPage();

    expect(container.textContent).toContain('@me:hs');
    // The editable field is empty (not prefilled with the user id).
    expect(fixture.componentInstance.nameDraft()).toBe('');
  });
});
