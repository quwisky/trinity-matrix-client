import { computed } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type Observable, defer, finalize, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdministeredRoomStore } from './administered-room.store';
import {
  administrationSession,
  roomWithAlice,
} from './room-administration.spec-harness';

async function setup() {
  const session = administrationSession();
  const { engine } = session;
  const roomId = await roomWithAlice(engine);
  let open = 0;
  const counted = <T>(source: Observable<T>): Observable<T> =>
    defer(() => {
      open += 1;
      return source.pipe(finalize(() => (open -= 1)));
    });
  const roomOf = engine.room.bind(engine);
  const membersOf = engine.members.bind(engine);
  const room = vi
    .spyOn(engine, 'room')
    .mockImplementation((accountId, id) => counted(roomOf(accountId, id)));
  const members = vi
    .spyOn(engine, 'members')
    .mockImplementation((accountId, id) => counted(membersOf(accountId, id)));
  TestBed.configureTestingModule({ providers: session.providers });
  return {
    ...session,
    roomId,
    store: TestBed.inject(AdministeredRoomStore),
    spies: { room, members },
    open: () => open,
  };
}

afterEach(() => TestBed.resetTestingModule());

describe('AdministeredRoomStore', () => {
  it('reads a room synchronously and follows its changes', async () => {
    const { store, engine, roomId } = await setup();
    const power = computed(() => store.room(engine.alice, roomId)?.ownPower);

    expect(power()).toBe(0);
    await engine.asBob.setPowerLevel(roomId, engine.alice, 50);
    expect(power()).toBe(50);
  });

  it('subscribes once per account and room, also from inside computeds', async () => {
    const { store, engine, roomId, spies } = await setup();
    const first = computed(() => store.room(engine.alice, roomId)?.roomId);
    const second = computed(() => store.room(engine.alice, roomId)?.roomId);

    expect([
      first(),
      second(),
      store.room(engine.alice, roomId)?.roomId,
    ]).toEqual([roomId, roomId, roomId]);
    expect(store.members(engine.alice, roomId)?.complete).toBe(true);
    expect(spies.room).toHaveBeenCalledTimes(1);
    expect(spies.members).toHaveBeenCalledTimes(1);
  });

  it('reads null without subscribing until the account is live', async () => {
    const { store, engine, roomId, signIn, spies } = await setup();
    signIn([]);
    const membership = computed(
      () => store.room(engine.alice, roomId)?.ownMembership ?? null,
    );

    expect(membership()).toBeNull();
    expect(spies.room).not.toHaveBeenCalled();
    signIn([engine.alice]);
    expect(membership()).toBe('join');
  });

  it('subscribes again for a new session generation', async () => {
    const { store, engine, roomId, signIn, spies, open } = await setup();
    const membership = computed(
      () => store.room(engine.alice, roomId)?.ownMembership ?? null,
    );
    expect(membership()).toBe('join');

    signIn([engine.alice], { generation: 2 });

    expect(membership()).toBe('join');
    expect(spies.room).toHaveBeenCalledTimes(2);
    expect(open()).toBe(1);
  });

  it('releases every subscription of an account that signs out, read or not', async () => {
    const { store, engine, roomId, signIn, open } = await setup();
    const membership = computed(
      () => store.room(engine.alice, roomId)?.ownMembership ?? null,
    );
    expect(membership()).toBe('join');
    store.members(engine.alice, roomId);
    expect(open()).toBe(2);

    signIn([]);
    TestBed.tick();

    expect(open()).toBe(0);
    expect(membership()).toBeNull();
  });

  it('subscribes again on the next read after the engine stream fails', async () => {
    const { store, engine, roomId, spies } = await setup();
    spies.room.mockImplementationOnce(() => throwError(() => new Error('x')));

    expect(store.room(engine.alice, roomId)).toBeNull();
    expect(store.room(engine.alice, roomId)?.roomId).toBe(roomId);
    expect(spies.room).toHaveBeenCalledTimes(2);
  });
});
