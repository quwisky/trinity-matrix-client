import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { RoomShellStore } from './room-shell-store';
import { WorkspaceNavigationService } from '@trinity/application/workspace';

describe('RoomShellStore Workspace lifetimes', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('releases exact-room member info when Account changes but Room id stays equal', () => {
    const activeAccountId = signal<string | null>('@alice:example.org');
    TestBed.configureTestingModule({
      providers: [
        RoomShellStore,
        {
          provide: WorkspaceNavigationService,
          useValue: {
            activeAccountId: activeAccountId.asReadonly(),
            activeSpaceId: signal<string | null>(null).asReadonly(),
            activeRoomId: signal<string | null>(
              '!shared:example.org',
            ).asReadonly(),
            recentView: signal(true).asReadonly(),
            roomsView: signal(false).asReadonly(),
            pane: signal<'list' | 'conversation'>('conversation').asReadonly(),
            placement: signal<'list' | 'conversation' | 'split'>(
              'split',
            ).asReadonly(),
          },
        },
      ],
    });
    const store = TestBed.inject(RoomShellStore);
    store.rightPanel.set({
      kind: 'member',
      member: {
        userId: '@bob:example.org',
        roomDisplayName: 'Bob',
        roomInitial: 'B',
        roomAvatarMxc: null,
        powerLevel: 0,
        isCreator: false,
      },
      direct: false,
    });

    activeAccountId.set('@bob:example.org');

    expect(store.rightPanel()?.kind).not.toBe('member');
  });
});
