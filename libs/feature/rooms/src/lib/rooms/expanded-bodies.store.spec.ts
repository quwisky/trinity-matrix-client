import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it } from 'vitest';
import { ExpandedBodiesStore } from './expanded-bodies.store';
import { RoomShellStore } from './room-shell-store';

describe('ExpandedBodiesStore', () => {
  const account = signal<string | null>('@me:hs');
  const room = signal<string | null>('!a:hs');
  let store: ExpandedBodiesStore;

  beforeEach(() => {
    account.set('@me:hs');
    room.set('!a:hs');
    TestBed.configureTestingModule({
      providers: [
        ExpandedBodiesStore,
        MockProvider(RoomShellStore, {
          activeAccountId: account.asReadonly(),
          activeRoomId: room.asReadonly(),
        }),
      ],
    });
    store = TestBed.inject(ExpandedBodiesStore);
  });

  it('starts with every body collapsed', () => {
    expect(store.expanded().size).toBe(0);
    expect(store.isExpanded('$a')).toBe(false);
  });

  it('toggles a body open and closed', () => {
    store.toggle('$a');
    expect(store.isExpanded('$a')).toBe(true);

    store.toggle('$a');
    expect(store.isExpanded('$a')).toBe(false);
  });

  it('expands a jump target once, however often it is asked', () => {
    store.expand('$a');
    store.expand('$a');

    expect([...store.expanded()]).toEqual(['$a']);
  });

  it('collapses everything when the selected room changes, and after coming back', () => {
    store.expand('$a');

    room.set('!b:hs');
    expect(store.expanded().size).toBe(0);

    room.set('!a:hs');
    expect(store.isExpanded('$a')).toBe(false);
  });

  it('collapses everything when the account changes', () => {
    store.expand('$a');

    account.set('@other:hs');

    expect(store.expanded().size).toBe(0);
  });

  it('keeps the set while the same room stays open', () => {
    store.expand('$a');

    room.set('!a:hs');

    expect(store.isExpanded('$a')).toBe(true);
  });
});
