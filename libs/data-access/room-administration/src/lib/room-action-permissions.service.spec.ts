import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { EventType, KnownMembership } from 'matrix-js-sdk';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  RoomActionPermissionError,
  RoomActionPermissionsService,
} from './room-action-permissions.service';
import { RoomAdministrationProjectionState } from './room-administration-projection-state.service';

interface MemberState {
  membership: KnownMembership;
  powerLevel: number;
}

interface ClientFixture {
  readonly client: {
    getRoom: Mock;
    getUserId: Mock;
    on: Mock;
    off: Mock;
  };
  readonly members: Map<string, MemberState>;
  readonly rules: {
    invite: number;
    kick: number;
    ban: number;
    state: number;
  };
}

const activeUserId = signal<string | null>('@me:hs');

beforeEach(() => activeUserId.set('@me:hs'));

function clientFixture(
  userId = '@me:hs',
  overrides: {
    membership?: KnownMembership;
    myPower?: number;
    targetPower?: number;
    targetMembership?: KnownMembership;
  } = {},
): ClientFixture {
  const members = new Map<string, MemberState>([
    [
      userId,
      {
        membership: overrides.membership ?? KnownMembership.Join,
        powerLevel: overrides.myPower ?? 50,
      },
    ],
    [
      '@target:hs',
      {
        membership: overrides.targetMembership ?? KnownMembership.Join,
        powerLevel: overrides.targetPower ?? 0,
      },
    ],
  ]);
  const rules = { invite: 50, kick: 50, ban: 50, state: 50 };
  const state = {
    hasSufficientPowerLevelFor: (
      action: 'invite' | 'kick' | 'ban',
      power: number,
    ) => power >= rules[action],
    maySendStateEvent: (_type: string, actor: string) =>
      (members.get(actor)?.powerLevel ?? 0) >= rules.state,
  };
  const room = {
    getMyMembership: () => members.get(userId)?.membership,
    getMember: (id: string) => members.get(id) ?? null,
    getLiveTimeline: () => ({ getState: () => state }),
  };
  return {
    members,
    rules,
    client: {
      getRoom: vi.fn((roomId: string) => (roomId === '!room:hs' ? room : null)),
      getUserId: vi.fn(() => userId),
      on: vi.fn(),
      off: vi.fn(),
    },
  };
}

function setup(initial = clientFixture()) {
  let current = initial;
  const clients = new Map<string, ClientFixture>([
    [initial.client.getUserId() as string, initial],
  ]);
  let initialized = true;
  TestBed.configureTestingModule({
    providers: [
      RoomActionPermissionsService,
      MockProvider(MatrixClientService, {
        get isInitialized() {
          return initialized;
        },
        get instance() {
          return current.client as never;
        },
        clientFor: (accountId: string) =>
          (clients.get(accountId)?.client as never) ?? null,
        activeUserId: activeUserId.asReadonly(),
      }),
    ],
  });
  const projectionState = TestBed.inject(RoomAdministrationProjectionState);
  projectionState.select(activeUserId(), '!room:hs');
  projectionState.update('permissions', 'available', 'retained');
  return {
    service: TestBed.inject(RoomActionPermissionsService),
    useClient: (next: ClientFixture, userId = '@other:hs') => {
      current = next;
      clients.set(userId, next);
      activeUserId.set(userId);
      projectionState.select(userId, '!room:hs');
      projectionState.update('permissions', 'available', 'retained');
    },
    signOut: () => {
      initialized = false;
      activeUserId.set(null);
      projectionState.release();
    },
    projectionState,
  };
}

function stateHandler(client: ClientFixture['client']) {
  return client.on.mock.calls.find(
    ([event]) => event === 'RoomState.events',
  )?.[1] as ((event: { getType(): string }) => void) | undefined;
}

function event(type: string) {
  return { getType: () => type };
}

describe('RoomActionPermissionsService', () => {
  it('reads exact-account permissions independently of the active account', () => {
    const selected = clientFixture('@selected:hs', { myPower: 100 });
    const active = clientFixture('@active:hs', { myPower: 0 });
    const { service, useClient } = setup(selected);

    useClient(active, '@active:hs');

    expect(service.room('!room:hs').curateSpace.available).toBe(false);
    expect(
      service.roomFor({
        accountId: '@selected:hs',
        roomId: '!room:hs',
      }).curateSpace.available,
    ).toBe(true);
  });

  it('requires a joined actor and the effective invite/state thresholds', () => {
    const fixture = clientFixture('@me:hs', { myPower: 49 });
    const { service } = setup(fixture);

    expect(service.room('!room:hs')).toMatchObject({
      invite: { available: false },
      curateSpace: { available: false },
    });

    fixture.members.get('@me:hs')!.powerLevel = 50;
    expect(service.room('!room:hs')).toEqual({
      invite: { available: true, reason: null },
      curateSpace: { available: true, reason: null },
    });

    fixture.members.get('@me:hs')!.membership = KnownMembership.Leave;
    expect(service.room('!room:hs').invite.reason).toContain('Join this room');
  });

  it('projects every settings field from the live state-event threshold', () => {
    const fixture = clientFixture('@me:hs', { myPower: 49 });
    const { service } = setup(fixture);

    expect(Object.values(service.settings('!room:hs'))).toHaveLength(6);
    expect(
      Object.values(service.settings('!room:hs')).every(
        (permission) => !permission.available && !!permission.reason,
      ),
    ).toBe(true);

    fixture.members.get('@me:hs')!.powerLevel = 50;
    expect(
      Object.values(service.settings('!room:hs')).every(
        (permission) => permission.available && permission.reason === null,
      ),
    ).toBe(true);
  });

  it.each([
    { myPower: 49, targetPower: 0, kick: false, ban: false, setPower: false },
    { myPower: 50, targetPower: 50, kick: false, ban: false, setPower: false },
    { myPower: 50, targetPower: 49, kick: true, ban: true, setPower: true },
    {
      myPower: Number.POSITIVE_INFINITY,
      targetPower: Number.POSITIVE_INFINITY,
      kick: false,
      ban: false,
      setPower: false,
    },
  ])(
    'applies thresholds and strict rank for member actions ($myPower over $targetPower)',
    ({ myPower, targetPower, kick, ban, setPower }) => {
      const { service } = setup(
        clientFixture('@me:hs', { myPower, targetPower }),
      );

      expect(service.member('!room:hs', '@target:hs')).toMatchObject({
        kick: { available: kick },
        ban: { available: ban },
        setPower: { available: setPower },
        myPower,
        targetPower,
      });
    },
  );

  it('only assigns roles at or below the actor and never targets self', () => {
    const { service } = setup(
      clientFixture('@me:hs', { myPower: 50, targetPower: 0 }),
    );

    expect(service.role('!room:hs', '@target:hs', 50).available).toBe(true);
    expect(service.role('!room:hs', '@target:hs', 51).reason).toContain(
      'above your own',
    );
    expect(service.member('!room:hs', '@me:hs').kick.available).toBe(false);
  });

  it('requires ban and kick thresholds plus strict rank to unban', () => {
    const fixture = clientFixture('@me:hs', {
      myPower: 50,
      targetPower: 0,
      targetMembership: KnownMembership.Ban,
    });
    const { service } = setup(fixture);

    expect(service.unban('!room:hs', '@target:hs').available).toBe(true);
    fixture.rules.kick = 60;
    expect(service.unban('!room:hs', '@target:hs').available).toBe(false);
    fixture.rules.kick = 50;
    fixture.members.get('@target:hs')!.powerLevel = 50;
    expect(service.unban('!room:hs', '@target:hs').reason).toContain(
      'lower role',
    );
  });

  it('invalidates consumers for remote threshold and membership changes only', async () => {
    const fixture = clientFixture('@me:hs', { myPower: 50 });
    const { service } = setup(fixture);
    service.runProjection().subscribe();
    const canInvite = computed(() => service.room('!room:hs').invite.available);
    expect(canInvite()).toBe(true);

    fixture.rules.invite = 60;
    stateHandler(fixture.client)?.(event(EventType.RoomTopic));
    await Promise.resolve();
    expect(canInvite()).toBe(true);

    stateHandler(fixture.client)?.(event(EventType.RoomPowerLevels));
    await Promise.resolve();
    expect(canInvite()).toBe(false);

    fixture.members.get('@me:hs')!.membership = KnownMembership.Leave;
    stateHandler(fixture.client)?.(event(EventType.RoomMember));
    await Promise.resolve();
    expect(service.room('!room:hs').invite.available).toBe(false);
  });

  it('rebinds on account switch and never exposes a detached client', () => {
    const first = clientFixture('@me:hs', { myPower: 50 });
    const second = clientFixture('@other:hs', { myPower: 0 });
    const { service, useClient, signOut } = setup(first);
    service.runProjection().subscribe();
    const firstHandler = stateHandler(first.client);

    useClient(second);
    TestBed.tick();
    expect(first.client.off).toHaveBeenCalledWith(
      'RoomState.events',
      firstHandler,
    );
    expect(second.client.on).toHaveBeenCalledWith(
      'RoomState.events',
      expect.any(Function),
    );
    expect(service.room('!room:hs').invite.available).toBe(false);

    signOut();
    expect(service.room('!room:hs').invite.available).toBe(false);
  });

  it('throws a typed error when a final mutation guard fails', () => {
    const { service } = setup();
    const availability = {
      available: false,
      reason: 'Your role cannot invite people to this room.',
    };

    expect(() => service.assert(availability)).toThrowError(
      RoomActionPermissionError,
    );
    expect(() =>
      service.assert({ available: true, reason: null }),
    ).not.toThrow();
  });

  it('blocks state-backed actions while current permission authority is unavailable', () => {
    const { service, projectionState } = setup();
    projectionState.update('permissions', 'failed', 'retained');

    expect(service.room('!room:hs').invite).toMatchObject({
      available: false,
      reason: expect.stringContaining('permissions are unavailable'),
    });
    expect(service.settings('!room:hs').topic.available).toBe(false);
    expect(service.member('!room:hs', '@target:hs').ban.available).toBe(false);
    expect(service.unban('!room:hs', '@target:hs').available).toBe(false);
  });

  it('keeps an exact-account read with its own current client authorization usable', () => {
    const { service, projectionState } = setup();
    projectionState.update('permissions', 'failed', 'retained');

    expect(
      service.roomFor({ accountId: '@me:hs', roomId: '!room:hs' }).invite
        .available,
    ).toBe(true);
  });
});
