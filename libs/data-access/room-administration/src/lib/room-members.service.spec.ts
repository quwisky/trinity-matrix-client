import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ProjectionRuntime } from '@trinity/runtime/projection';
import { firstValueFrom, filter } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomMembersService } from './room-members.service';
import type { RoomMembersSnapshot } from './room-members.service';
import { RoomAdministrationProjectionState } from './room-administration-projection-state.service';
import {
  administrationSession,
  roomWithAlice,
} from './room-administration.spec-harness';

/** Alice (active) in bob's room, with the members and bans operations coherent. */
async function setup(options: { readonly roomVersion?: string } = {}) {
  const session = administrationSession();
  const { engine } = session;
  const roomId = await roomWithAlice(engine, options);
  TestBed.configureTestingModule({ providers: session.providers });
  const projectionState = TestBed.inject(RoomAdministrationProjectionState);
  projectionState.select(engine.alice, roomId);
  projectionState.update('members', 'available', 'retained');
  projectionState.update('bans', 'available', 'retained');
  return {
    ...session,
    roomId,
    target: { accountId: engine.alice, roomId },
    service: TestBed.inject(RoomMembersService),
    projectionState,
    /** Bob signs in beside alice and becomes the active account. */
    activateBob: (): void => {
      engine.setLive(engine.bob, true);
      session.signIn([engine.alice, engine.bob], { active: engine.bob });
    },
  };
}

const names = (members: readonly { readonly roomDisplayName: string }[]) =>
  members.map((member) => member.roomDisplayName);

afterEach(() => TestBed.resetTestingModule());

describe('RoomMembersService', () => {
  it('projects sorted joined members with creator, avatar and power', async () => {
    const { service, roomId, engine } = await setup();
    await engine.asBob.setDisplayName(roomId, 'Zoe');
    await engine.asBob.invite(roomId, engine.carol);
    await engine.asCarol.join(roomId);
    await engine.asCarol.setDisplayName(roomId, 'Ada');
    await engine.asCarol.setAvatar(roomId, 'mxc://example.org/ada');
    await engine.asBob.setPowerLevel(roomId, engine.carol, 50);

    expect(service.membersOf(roomId)).toEqual([
      {
        userId: engine.alice,
        roomDisplayName: engine.alice,
        roomInitial: 'A',
        roomAvatarMxc: null,
        powerLevel: 0,
        isCreator: false,
      },
      {
        userId: engine.carol,
        roomDisplayName: 'Ada',
        roomInitial: 'A',
        roomAvatarMxc: 'mxc://example.org/ada',
        powerLevel: 50,
        isCreator: false,
      },
      {
        userId: engine.bob,
        roomDisplayName: 'Zoe',
        roomInitial: 'Z',
        roomAvatarMxc: null,
        powerLevel: 100,
        isCreator: true,
      },
    ]);
  });

  it('gives a v12 creator infinite power and only the create sender the creator mark', async () => {
    const session = administrationSession();
    const { engine } = session;
    const roomId = await engine.asBob.createRoom({
      roomVersion: '12',
      additionalCreators: [engine.alice],
    });
    await engine.asBob.invite(roomId, engine.alice);
    await engine.asAlice.join(roomId);
    TestBed.configureTestingModule({ providers: session.providers });
    const members = TestBed.inject(RoomMembersService).membersOf(roomId);

    expect(
      members.map(({ userId, powerLevel, isCreator }) => ({
        userId,
        powerLevel,
        isCreator,
      })),
    ).toEqual([
      { userId: engine.alice, powerLevel: Infinity, isCreator: false },
      { userId: engine.bob, powerLevel: Infinity, isCreator: true },
    ]);
  });

  it('shows the engine-disambiguated names in the role lists', async () => {
    const { service, roomId, engine } = await setup();
    await engine.asBob.invite(roomId, engine.carol);
    await engine.asCarol.join(roomId);
    await engine.asBob.setDisplayName(roomId, 'Twin');
    await engine.asCarol.setDisplayName(roomId, 'Twin');

    expect(names(service.membersOf(roomId))).toEqual([
      engine.alice,
      `Twin (${engine.bob})`,
      `Twin (${engine.carol})`,
    ]);
  });

  it('shares a signal per room that follows member changes and keeps its list while unchanged', async () => {
    const { service, roomId, engine } = await setup();
    const roster = service.membersFor(roomId);
    expect(roster).toBe(service.membersFor(roomId));
    const before = roster();

    await engine.asBob.setPowerLevels(roomId, { kick: 60 });
    expect(roster()).toBe(before);

    await engine.asBob.invite(roomId, engine.carol);
    await engine.asCarol.join(roomId);
    expect(roster().map((member) => member.userId)).toContain(engine.carol);
  });

  it('reprojects power changes even when member identity is unchanged', async () => {
    const { service, roomId, engine } = await setup();
    const roster = service.membersFor(roomId);

    await engine.asBob.setPowerLevel(roomId, engine.alice, 50);

    expect(
      roster().find((member) => member.userId === engine.alice)?.powerLevel,
    ).toBe(50);
  });

  it('projects sorted bans with their reasons and follows them', async () => {
    const { service, roomId, engine } = await setup();
    await engine.asBob.ban(roomId, '@zed:example.org', 'spam');
    await engine.asBob.ban(roomId, '@amy:example.org', '');
    const bans = service.bannedFor(roomId);

    expect(bans()).toEqual([
      {
        userId: '@amy:example.org',
        roomDisplayName: '@amy:example.org',
        reason: null,
      },
      {
        userId: '@zed:example.org',
        roomDisplayName: '@zed:example.org',
        reason: 'spam',
      },
    ]);

    await engine.asBob.ban(roomId, '@bea:example.org', 'spam');
    expect(bans().map((ban) => ban.userId)).toEqual([
      '@amy:example.org',
      '@bea:example.org',
      '@zed:example.org',
    ]);
  });

  it('projects invited members apart from joined ones and follows them', async () => {
    const { service, roomId, engine } = await setup();
    await engine.asBob.invite(roomId, engine.carol);
    await engine.asBob.invite(roomId, '@ann:example.org');
    const pending = service.invitedFor(roomId);

    expect(pending().map((member) => member.userId)).toEqual([
      '@ann:example.org',
      engine.carol,
    ]);
    expect(
      service
        .membersFor(roomId)()
        .map((member) => member.userId),
    ).toEqual([engine.alice, engine.bob]);

    await engine.asCarol.join(roomId);
    expect(pending().map((member) => member.userId)).toEqual([
      '@ann:example.org',
    ]);
  });

  it('projects a knock with its reason and avatar, and drops it once withdrawn', async () => {
    const { service, roomId, engine } = await setup();
    await engine.asCarol.knock(roomId, 'From the meetup');
    await engine.asCarol.setDisplayName(roomId, 'Carol');
    await engine.asCarol.setAvatar(roomId, 'mxc://example.org/carol');
    const requests = service.knockingFor(roomId);

    expect(requests()).toEqual([
      {
        userId: engine.carol,
        roomDisplayName: 'Carol',
        roomInitial: 'C',
        roomAvatarMxc: 'mxc://example.org/carol',
        reason: 'From the meetup',
      },
    ]);

    await engine.asCarol.leave(roomId);
    expect(requests()).toEqual([]);
  });

  it('follows an account switch and never shows the previous account’s members', async () => {
    const { service, roomId, engine, activateBob, signIn } = await setup();
    const otherRoom = await engine.asBob.createRoom();
    const roster = service.membersFor(otherRoom);
    const here = service.membersFor(roomId);
    expect(roster()).toEqual([]);
    expect(here()).toHaveLength(2);

    activateBob();
    expect(roster().map((member) => member.userId)).toEqual([engine.bob]);

    signIn([engine.alice]);
    engine.setLive(engine.bob, false);
    expect(roster()).toEqual([]);

    signIn([]);
    expect(here()).toEqual([]);
    expect(service.knockingFor(roomId)()).toEqual([]);
  });

  it('carries invited and knocking in the snapshot of an available exact target', async () => {
    const { service, roomId, engine, target } = await setup();
    await engine.asBob.invite(roomId, '@ann:example.org');
    await engine.asCarol.knock(roomId, 'Hi');

    const snapshot = service.snapshot(target);

    expect(snapshot).toMatchObject({
      target,
      availability: 'available',
      unavailableReason: null,
    });
    expect(snapshot.members.map((member) => member.userId)).toEqual([
      engine.alice,
      engine.bob,
    ]);
    expect(snapshot.invited.map((member) => member.userId)).toEqual([
      '@ann:example.org',
    ]);
    expect(snapshot.knocking.map((request) => request.reason)).toEqual(['Hi']);
  });

  it('leaves the lists empty when the room is not joined', async () => {
    const { service, engine } = await setup();
    const roomId = await engine.asBob.createRoom();
    await engine.asBob.invite(roomId, engine.alice);
    await engine.asBob.invite(roomId, '@ann:example.org');

    const snapshot = service.snapshot({ accountId: engine.alice, roomId });

    expect(snapshot).toMatchObject({
      availability: 'room-unavailable',
      unavailableReason: 'This room is no longer joined for this account.',
      members: [],
      banned: [],
      invited: [],
      knocking: [],
    });
  });

  it('observes an exact opening account at once, independently of the active account', async () => {
    const { service, roomId, engine, target, activateBob, signIn } =
      await setup();
    activateBob();
    const seen: RoomMembersSnapshot[] = [];
    const observation = service
      .observe(target)
      .subscribe((value) => seen.push(value));

    expect(seen).toHaveLength(1);
    expect(seen[0].availability).toBe('available');

    await engine.asBob.invite(roomId, engine.carol);
    await engine.asCarol.join(roomId);
    TestBed.inject(ApplicationRef).tick();
    expect(seen.at(-1)?.members.map((member) => member.userId)).toContain(
      engine.carol,
    );

    signIn([engine.bob]);
    TestBed.inject(ApplicationRef).tick();
    expect(seen.at(-1)).toMatchObject({
      availability: 'account-unavailable',
      unavailableReason:
        'This account is no longer available. The member list remains attached to this account.',
      members: [],
    });
    observation.unsubscribe();
  });

  it('stops recomputing an observed snapshot once unsubscribed', async () => {
    const { service, roomId, engine, target } = await setup();
    const snapshot = vi.spyOn(service, 'snapshot');
    const tick = () => TestBed.inject(ApplicationRef).tick();
    const seen: RoomMembersSnapshot[] = [];
    const observation = service
      .observe(target)
      .subscribe((value) => seen.push(value));
    tick();
    await engine.asBob.invite(roomId, engine.carol);
    tick();
    expect(seen).toHaveLength(2);

    observation.unsubscribe();
    const calls = snapshot.mock.calls.length;
    await engine.asCarol.join(roomId);
    tick();

    expect(snapshot.mock.calls.length).toBe(calls);
    expect(seen).toHaveLength(2);
  });

  it('keeps the members lease for the active account', async () => {
    const { service } = await setup();
    const runtime = TestBed.inject(ProjectionRuntime);
    const subscription = service.runProjection().subscribe();

    await expect(
      firstValueFrom(
        runtime
          .observe('room-administration.members', { kind: 'active-account' })
          .pipe(filter((state) => state.condition === 'available')),
      ),
    ).resolves.toMatchObject({ condition: 'available' });
    subscription.unsubscribe();
  });

  it('fails the members lease while a held list cannot be read and recovers on retry', async () => {
    const { service, roomId } = await setup();
    const runtime = TestBed.inject(ProjectionRuntime);
    const condition = (wanted: string) =>
      firstValueFrom(
        runtime
          .observe('room-administration.members', { kind: 'active-account' })
          .pipe(filter((state) => state.condition === wanted)),
      );
    service.membersFor(roomId);
    const subscription = service.runProjection().subscribe();
    await condition('available');
    const membersOf = service.membersOf;

    service.membersOf = () => {
      throw new Error('synthetic member read');
    };
    service.retryProjection();
    await expect(condition('failed')).resolves.toBeTruthy();

    service.membersOf = membersOf;
    service.retryProjection();
    await expect(condition('available')).resolves.toBeTruthy();
    subscription.unsubscribe();
  });

  it('separates coherent, stale, and unavailable membership presentation', async () => {
    const { service, roomId, engine, projectionState } = await setup();

    expect(service.membersView(roomId)).toMatchObject({
      availability: 'coherent',
      current: [{ userId: engine.alice }, { userId: engine.bob }],
      stale: null,
    });

    projectionState.update('members', 'failed', 'retained');
    expect(service.membersView(roomId)).toMatchObject({
      availability: 'stale',
      current: null,
      stale: [{ userId: engine.alice }, { userId: engine.bob }],
    });

    projectionState.update('members', 'released', 'released');
    expect(service.membersView(roomId)).toEqual({
      availability: 'unavailable',
      current: null,
      stale: null,
    });
  });

  it('does not label an unavailable empty ban list as authoritative', async () => {
    const { service, roomId, projectionState } = await setup();
    projectionState.update('bans', 'released', 'released');

    expect(service.bannedView(roomId)).toEqual({
      availability: 'unavailable',
      current: null,
      stale: null,
    });
  });
});
