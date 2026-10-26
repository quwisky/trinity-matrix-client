import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventType, MatrixEvent, RoomState } from 'matrix-js-sdk';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { RoomMessageGovernanceService } from './room-message-governance.service';

const KEY = { accountId: '@alice:hs', roomId: '!shared:hs' } as const;

function setup({
  allow = true,
  state: realState,
}: { allow?: boolean; state?: unknown } = {}) {
  const event = { getId: () => '$message' };
  const state = {
    maySendEvent: vi.fn(() => allow),
    hasSufficientPowerLevelFor: vi.fn(() => allow),
    maySendRedactionForEvent: vi.fn(() => allow),
  };
  const room = {
    roomId: KEY.roomId,
    getLiveTimeline: () => ({ getState: () => realState ?? state }),
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

  describe('canSendMessages', () => {
    const powerLevels = (content: object) => {
      const state = new RoomState(KEY.roomId);
      state.setStateEvents([
        new MatrixEvent({
          type: EventType.RoomPowerLevels,
          state_key: '',
          sender: '@admin:hs',
          room_id: KEY.roomId,
          event_id: '$pl',
          content,
        }),
      ]);
      return state;
    };

    it('follows events_default', () => {
      const { governance } = setup({
        state: powerLevels({ events_default: 50 }),
      });

      expect(governance.canSendMessages(KEY)).toBe(false);
    });

    it('is true when events_default is 0', () => {
      const { governance } = setup({
        state: powerLevels({ events_default: 0 }),
      });

      expect(governance.canSendMessages(KEY)).toBe(true);
    });

    it('honours an m.room.message override', () => {
      const { governance } = setup({
        state: powerLevels({ events: { 'm.room.message': 50 } }),
      });

      expect(governance.canSendMessages(KEY)).toBe(false);
    });
  });
});
