import { signal } from '@angular/core';
import { DialogRef } from '@trinity/kit/overlay';
import { render } from '@trinity/testing';
import { MockComponent, MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  PresenceService,
  ProfileService,
  type UserProfile,
} from '@trinity/data-access/profile';
import { AvatarComponent } from '@trinity/ui';
import { UserCardComponent } from './user-card.component';

async function setup(
  profile: UserProfile = {
    userId: '@bob:hs',
    displayName: 'Bob',
    avatarMxc: 'mxc://hs/b',
  },
) {
  const close = vi.fn();
  const { fixture, container } = await render(UserCardComponent, {
    inputs: { userId: '@bob:hs' },
    providers: [
      { provide: DialogRef, useValue: { close } },
      MockProvider(ProfileService, { fetch: () => of(profile) }),
      MockProvider(PresenceService, {
        presenceFor: () => signal('online' as const).asReadonly(),
      }),
    ],
    componentImports: [MockComponent(AvatarComponent)],
  });
  return { cmp: fixture.componentInstance, container, close };
}

describe('UserCardComponent', () => {
  it('shows the fetched display name and user id', async () => {
    const { container } = await setup();
    const text = container.textContent ?? '';
    expect(text).toContain('Bob');
    expect(text).toContain('@bob:hs');
  });

  it('falls back to the user id when there is no display name', async () => {
    const { cmp } = await setup({
      userId: '@bob:hs',
      displayName: '',
      avatarMxc: null,
    });
    expect(cmp.displayName()).toBe('@bob:hs');
  });

  it('closes with the user id when "Message" is chosen', async () => {
    const { container, close } = await setup();
    container
      .querySelector<HTMLButtonElement>('[data-testid=user-card-message]')!
      .click();
    expect(close).toHaveBeenCalledWith('@bob:hs');
  });

  it('closes with null when dismissed', async () => {
    const { cmp, close } = await setup();
    cmp.close();
    expect(close).toHaveBeenCalledWith(null);
  });
});
