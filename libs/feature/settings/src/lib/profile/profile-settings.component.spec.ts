import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { render } from '@trinity/testing';
import { MockComponent, MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileService, type UserProfile } from '@trinity/data-access/profile';
import { AvatarComponent } from '@trinity/components/avatar';
import { ProfileSettingsComponent } from './profile-settings.component';
import { provideTrnIcons } from '@trinity/components/icon';

describe('ProfileSettingsComponent', () => {
  let profile: ReturnType<typeof signal<UserProfile | null>>;

  const PROFILE: UserProfile = {
    userId: '@me:hs',
    displayName: 'Alice',
    avatarMxc: null,
  };

  beforeEach(() => {
    profile = signal<UserProfile | null>(PROFILE);
  });

  async function renderPage() {
    const result = await render(ProfileSettingsComponent, {
      imports: [MockComponent(AvatarComponent)],
      providers: [
        // Icons are registered once at the app root now (provideTrnIcons in main.ts),
        // not by each component, so a spec that asserts a real <svg> has to mirror that
        // root registration the way the running app provides it.
        provideTrnIcons(),
        MockProvider(ProfileService, {
          profile,
          // load() reflects the current signal so a test can preset an empty profile.
          load: () => of(profile()!),
        }),
      ],
    });
    const profileSvc = TestBed.inject(ProfileService);
    // The save actions return cold Observables the page feeds to runWithBusy.
    vi.mocked(profileSvc.setDisplayName).mockReturnValue(of(undefined));
    vi.mocked(profileSvc.setAvatar).mockReturnValue(of(undefined));
    return { ...result, profileSvc };
  }

  it('renders the profile and seeds the editable name', async () => {
    const { fixture, container } = await renderPage();

    expect(container.textContent).toContain('Alice');
    expect(container.textContent).toContain('@me:hs');
    expect(fixture.componentInstance.nameDraft()).toBe('Alice'); // seeded by load()
  });

  it('updates the draft name from a native input event', async () => {
    const { fixture } = await renderPage();
    const cmp = fixture.componentInstance;

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

  it('renders the avatar change control as a labelled icon button', async () => {
    const { container } = await renderPage();

    const change = container.querySelector<HTMLButtonElement>(
      '[data-testid=change-avatar]',
    );
    expect(change).not.toBeNull();
    expect(change?.tagName).toBe('BUTTON');
    // Icon-only: an accessible label stands in for the removed "Change" text.
    expect(change?.getAttribute('aria-label')).toBe('Change profile picture');
    expect(change?.textContent?.trim()).toBe('');
    // The camera icon renders as an SVG.
    expect(change?.querySelector('svg')).not.toBeNull();
    // It sits as a corner badge inside the avatar wrapper, beside the avatar.
    expect(change?.parentElement?.querySelector('trn-avatar')).not.toBeNull();
  });

  it('reflects the uploading state on the change control', async () => {
    const { fixture, container } = await renderPage();
    const change = () =>
      container.querySelector<HTMLButtonElement>('[data-testid=change-avatar]');

    expect(change()?.disabled).toBe(false);

    fixture.componentInstance.savingAvatar.set(true);
    fixture.detectChanges();

    // Disabled, relabelled, and the icon spins while the upload is in flight.
    expect(change()?.disabled).toBe(true);
    expect(change()?.getAttribute('aria-label')).toBe(
      'Uploading profile picture',
    );
    expect(change()?.querySelector('.animate-spin')).not.toBeNull();
  });

  it('opens the file picker when the change control is clicked', async () => {
    const { container } = await renderPage();

    const fileInput = container.querySelector<HTMLInputElement>(
      '[data-testid=avatar-input]',
    );
    const clickSpy = vi
      .spyOn(fileInput!, 'click')
      .mockImplementation(() => undefined);

    container
      .querySelector<HTMLButtonElement>('[data-testid=change-avatar]')
      ?.click();

    expect(clickSpy).toHaveBeenCalled();
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
    profile.set({ userId: '@me:hs', displayName: '', avatarMxc: null });
    const { fixture, container } = await renderPage();

    expect(container.textContent).toContain('@me:hs');
    // The editable field is empty (not prefilled with the user id).
    expect(fixture.componentInstance.nameDraft()).toBe('');
  });
});
