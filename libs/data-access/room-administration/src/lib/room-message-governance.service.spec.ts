import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { RoomMessageGovernanceService } from './room-message-governance.service';

const KEY = { accountId: '@alice:hs', roomId: '!shared:hs' } as const;

function setup({ allow = true }: { allow?: boolean } = {}) {
  const event = { getId: () => '$message' };
  const state = {
    maySendEvent: vi.fn(() => allow),
    hasSufficientPowerLevelFor: vi.fn(() => allow),
    maySendRedactionForEvent: vi.fn(() => allow),
  };
  const room = {
    roomId: KEY.roomId,
    getLiveTimeline: () => ({ getState: () => state }),
    getMember: () => ({ powerLevel: 50 }),
    findEventById: (eventId: string) =>
      eventId === '$message' ? event : undefined,
  };
  const otherRoom = { ...room };
  const client = {
    getUserId: () => KEY.accountId,
    getRoom: vi.fn(() => room),
  };
  const otherClient = {
    getUserId: () => '@other:hs',
    getRoom: vi.fn(() => otherRoom),
  };
  TestBed.configureTestingModule({
    providers: [
      {
        provide: MatrixClientService,
        useValue: {
          clientFor: (accountId: string) =>
            accountId === KEY.accountId ? client : otherClient,
        },
      },
    ],
  });
  return {
    governance: TestBed.inject(RoomMessageGovernanceService),
    state,
    client,
    otherClient,
    event,
  };
}

afterEach(() => TestBed.resetTestingModule());

describe('RoomMessageGovernanceService', () => {
  it('resolves moderator affordances through the exact Account client', () => {
    const { governance, state, client, otherClient } = setup();

    expect(governance.canRedactOthers(KEY)).toBe(true);
    expect(client.getRoom).toHaveBeenCalledWith(KEY.roomId);
    expect(otherClient.getRoom).not.toHaveBeenCalled();
    expect(state.maySendEvent).toHaveBeenCalledWith(
      'm.room.redaction',
      KEY.accountId,
    );
  });

  it('delegates each event decision to the SDK RoomState policy', () => {
    const { governance, state, event } = setup();

    expect(
      governance.authorizeRedaction({ ...KEY, messageId: '$message' }),
    ).toEqual({ kind: 'allowed' });
    expect(state.maySendRedactionForEvent).toHaveBeenCalledWith(
      event,
      KEY.accountId,
    );
  });

  it('returns typed denials for absent messages and insufficient authority', () => {
    const denied = setup({ allow: false });
    expect(
      denied.governance.authorizeRedaction({
        ...KEY,
        messageId: '$message',
      }),
    ).toEqual({ kind: 'rejected', failure: 'not-allowed' });
    expect(
      denied.governance.authorizeRedaction({ ...KEY, messageId: '$missing' }),
    ).toEqual({ kind: 'rejected', failure: 'message-unavailable' });
  });
});
