import { signal } from '@angular/core';
import {
  EMPTY_SESSION,
  SESSION_SNAPSHOT,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import {
  FakeRoomAdministrationEngine,
  type FakeRoomOptions,
} from '../contract/fake-room-administration-engine';
import type { AdministeredRoom } from './room-administration-engine';
import { ROOM_ADMINISTRATION_ENGINE } from './room-administration-engine.token';

/** A fake engine and a session where `accounts` are live (generation 1) and the first is active. */
export function administrationSession(
  accounts: readonly string[] = ['@alice:example.org'],
) {
  const engine = new FakeRoomAdministrationEngine();
  const snapshot = signal<SessionSnapshot>(EMPTY_SESSION);
  const signIn = (
    accountIds: readonly string[],
    { generation = 1, active = accountIds[0] ?? null } = {},
  ): void =>
    snapshot.set({
      ...EMPTY_SESSION,
      activeAccountId: active,
      accounts: accountIds.map((accountId) => ({
        accountId,
        generation,
        syncState: 'syncing',
        serverSynced: true,
        roomsPrepared: true,
        waitingCount: 0,
        cryptoStoreEncrypted: true,
      })),
    });
  signIn(accounts);
  return {
    engine,
    signIn,
    providers: [
      { provide: SESSION_SNAPSHOT, useValue: snapshot.asReadonly() },
      { provide: ROOM_ADMINISTRATION_ENGINE, useValue: engine },
    ],
  };
}

/** A room bob created and alice joined. */
export async function roomWithAlice(
  engine: FakeRoomAdministrationEngine,
  options: FakeRoomOptions = {},
): Promise<string> {
  const roomId = await engine.asBob.createRoom(options);
  await engine.asBob.invite(roomId, engine.alice);
  await engine.asAlice.join(roomId);
  return roomId;
}

/** A joined room with no state but `overrides`, for a stubbed `AdministeredRoomStore`. */
export function administeredRoom(
  roomId: string,
  ownUserId: string,
  overrides: Partial<AdministeredRoom> = {},
): AdministeredRoom {
  return {
    roomId,
    ownUserId,
    ownMembership: 'join',
    ownPower: 0,
    powerLevels: null,
    isSpace: false,
    state: {
      create: null,
      name: null,
      topic: null,
      avatar: null,
      joinRules: null,
      historyVisibility: null,
      canonicalAlias: null,
      encryption: null,
      tombstone: null,
    },
    spaceParents: [],
    creators: [],
    encryption: 'unencrypted',
    ...overrides,
  };
}
