import { signal } from '@angular/core';
import { render, screen } from '@testing-library/angular';
import { AvatarComponent } from '@trinity/ui';
import { PresenceService } from '@trinity/data-access-profile';
import { type PresenceState } from '@trinity/util-matrix';
import { MockComponent } from 'ng-mocks';
import { describe, expect, it } from 'vitest';
import { MemberListComponent } from './member-list.component';

// Stub presence per user id (defaults to offline).
const presenceMap: Record<string, PresenceState> = {
  '@z:hs': 'online',
  '@a:hs': 'offline',
};
const presenceStub = {
  presenceFor: (userId: string) =>
    signal<PresenceState>(presenceMap[userId] ?? 'offline'),
};
const providers = [{ provide: PresenceService, useValue: presenceStub }];

// Input arrives name-sorted (Anna, Zoe) — but Anna is offline and Zoe is online.
const MEMBERS = [
  { userId: '@a:hs', name: 'Anna', initial: 'A', avatarMxc: null },
  { userId: '@z:hs', name: 'Zoe', initial: 'Z', avatarMxc: null },
];

describe('MemberListComponent', () => {
  it('orders online members above offline ones, keeping names within a group', async () => {
    const { container } = await render(MemberListComponent, {
      inputs: { members: MEMBERS },
      imports: [MockComponent(AvatarComponent)],
      providers,
    });

    const names = [...container.querySelectorAll('.member__name')].map((n) =>
      n.textContent?.trim(),
    );
    // Zoe (online) rises above Anna (offline) despite Anna sorting first by name.
    expect(names).toEqual(['Zoe', 'Anna']);
  });

  it('dims offline members and shows an online-of-total count', async () => {
    const { container } = await render(MemberListComponent, {
      inputs: { members: MEMBERS },
      imports: [MockComponent(AvatarComponent)],
      providers,
    });

    expect(container.querySelector('.category')?.textContent).toContain(
      '1 of 2 online',
    );
    const rows = container.querySelectorAll('.member');
    expect(rows.length).toBe(2);
    // The offline member (Anna, second row after sorting) carries the dim class.
    const offline = container.querySelector('.member--offline');
    expect(offline?.textContent).toContain('Anna');
  });

  it('emits closed when the header close button is clicked', async () => {
    const { fixture } = await render(MemberListComponent, {
      imports: [MockComponent(AvatarComponent)],
      providers,
    });

    let closed = false;
    fixture.componentInstance.closed.subscribe(() => (closed = true));
    screen.getByTestId('close-members').click();

    expect(closed).toBe(true);
  });
});
