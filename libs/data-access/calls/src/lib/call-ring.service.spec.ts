import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallRingService } from './call-ring.service';

const NOW = Date.parse('2026-11-27T12:00:00Z');
const RING = 'org.matrix.msc4075.rtc.notification';
const MEMBER = 'org.matrix.msc3401.call.member';
const DECLINE = 'org.matrix.msc4310.rtc.decline';

interface Fake {
  type: string;
  id: string;
  sender: string;
  room: string;
  content: Record<string, unknown>;
  ts?: number;
  failed?: boolean;
}
const ev = (f: Fake) => ({
  getType: () => f.type,
  getId: () => f.id,
  getSender: () => f.sender,
  getRoomId: () => f.room,
  getContent: () => f.content,
  getTs: () => f.ts ?? NOW,
  isDecryptionFailure: () => f.failed === true,
});
const ringEv = (over: Partial<Fake> = {}, content = {}): Fake => ({
  type: RING,
  id: '$ring',
  sender: '@bob:hs',
  room: '!dm:hs',
  content: {
    notification_type: 'ring',
    sender_ts: NOW,
    lifetime: 30_000,
    'm.call.intent': 'video',
    ...content,
  },
  ...over,
});

function makeClient() {
  const bus = new EventEmitter();
  // The caller is in the call unless a test says otherwise.
  const members: unknown[] = [
    ev({
      type: MEMBER,
      id: '$caller',
      sender: '@bob:hs',
      room: '!dm:hs',
      content: { memberships: [{ application: 'm.call' }] },
    }),
  ];
  const client = Object.assign(bus, {
    members,
    sendEvent: vi.fn().mockResolvedValue({}),
    getAccountData: () => ({
      getContent: () => ({ '@bob:hs': ['!dm:hs'] }),
    }),
    getRoom: () => ({
      getMember: () => ({ name: 'Bob' }),
      getLiveTimeline: () => ({
        getState: () => ({ getStateEvents: () => members }),
      }),
    }),
  });
  return client;
}
type FakeClient = ReturnType<typeof makeClient>;

describe('CallRingService', () => {
  const accountIds = signal<string[]>([]);
  const activeUserId = signal('@me:hs');
  let clients: Record<string, FakeClient>;
  let service: CallRingService;

  const live = (c: FakeClient, f: Fake, liveEvent = true): void => {
    c.emit('Room.timeline', ev(f), {}, false, false, { liveEvent });
  };
  const memberEv = (sender: string, content: Record<string, unknown>) =>
    ev({ type: MEMBER, id: '$m', sender, room: '!dm:hs', content });

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    clients = { '@me:hs': makeClient(), '@you:hs': makeClient() };
    activeUserId.set('@me:hs');
    accountIds.set(['@me:hs']);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MatrixClientService,
          useValue: {
            accountIds,
            activeUserId,
            clientFor: (id: string) => clients[id] ?? null,
          },
        },
      ],
    });
    service = TestBed.inject(CallRingService);
    TestBed.tick();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('rings for a direct chat call with the caller name and intent', () => {
    live(clients['@me:hs'], ringEv());
    expect(service.incomingRing()).toEqual({
      id: '$ring',
      roomId: '!dm:hs',
      accountId: '@me:hs',
      callerId: '@bob:hs',
      callerName: 'Bob',
      video: true,
      expiresAt: NOW + 30_000,
    });
  });

  it('does not ring for own, non-direct, non-live or already-joined events', () => {
    const c = clients['@me:hs'];
    live(c, ringEv({ sender: '@me:hs' }));
    live(c, ringEv({ room: '!group:hs' }));
    live(c, ringEv(), false);
    c.members.push(
      memberEv('@me:hs', { memberships: [{ application: 'm.call' }] }),
    );
    live(c, ringEv());
    expect(service.incomingRing()).toBeNull();
  });

  it("does not ring once the caller's call has ended, as on a reload", () => {
    const c = clients['@me:hs'];
    c.members.length = 0;
    live(c, ringEv());
    c.members.push(memberEv('@bob:hs', {}));
    live(c, ringEv());
    expect(service.incomingRing()).toBeNull();
  });

  it('rings once on decryption, and not after expiry', () => {
    const c = clients['@me:hs'];
    live(c, { ...ringEv(), type: 'm.room.encrypted', content: {} });
    expect(service.incomingRing()).toBeNull();
    const set = vi.spyOn(
      (service as unknown as { ring: { set(v: unknown): void } }).ring,
      'set',
    );
    c.emit('Event.decrypted', ev(ringEv()));
    expect(service.incomingRing()?.id).toBe('$ring');
    c.emit('Event.decrypted', ev(ringEv()));
    expect(service.incomingRing()?.id).toBe('$ring');
    expect(set.mock.calls.filter(([ring]) => ring !== null)).toHaveLength(1);

    service.dismiss();
    live(c, {
      ...ringEv({ id: '$late' }),
      type: 'm.room.encrypted',
      content: {},
    });
    vi.setSystemTime(NOW + 31_000);
    c.emit('Event.decrypted', ev(ringEv({ id: '$late' })));
    expect(service.incomingRing()).toBeNull();
  });

  it('clears at expiry', () => {
    live(clients['@me:hs'], ringEv());
    vi.advanceTimersByTime(30_000);
    expect(service.incomingRing()).toBeNull();
  });

  it('clears when the caller leaves the call', () => {
    const c = clients['@me:hs'];
    live(c, ringEv());
    c.members.length = 0;
    c.emit('RoomState.events', memberEv('@bob:hs', {}));
    expect(service.incomingRing()).toBeNull();
  });

  it('keeps ringing while another caller device is still in the call', () => {
    const c = clients['@me:hs'];
    live(c, ringEv());
    // The default member is the remaining device; the event is the other one leaving.
    c.emit('RoomState.events', memberEv('@bob:hs', {}));
    expect(service.incomingRing()).not.toBeNull();
  });

  it('rings when the caller membership and the ring arrive in one batch', () => {
    const c = clients['@me:hs'];
    c.members.length = 0;
    c.members.push(
      memberEv('@bob:hs', { memberships: [{ application: 'm.call' }] }),
    );
    c.emit('RoomState.events', c.members[0]);
    live(c, ringEv());
    expect(service.incomingRing()?.id).toBe('$ring');
  });

  it('rings when a failed decryption is retried successfully in time', () => {
    const c = clients['@me:hs'];
    live(c, { ...ringEv(), type: 'm.room.encrypted', content: {} });
    c.emit('Event.decrypted', ev({ ...ringEv(), failed: true }));
    expect(service.incomingRing()).toBeNull();
    c.emit('Event.decrypted', ev(ringEv()));
    expect(service.incomingRing()?.id).toBe('$ring');
  });

  it('prunes encrypted ids that never decrypted after two minutes', () => {
    const c = clients['@me:hs'];
    const pending = (
      service as unknown as {
        bindings: Map<string, { pending: Map<string, number> }>;
      }
    ).bindings.get('@me:hs')?.pending;
    live(c, { ...ringEv({ id: '$old' }), type: 'm.room.encrypted' });
    vi.setSystemTime(NOW + 121_000);
    live(c, { ...ringEv({ id: '$new' }), type: 'm.room.encrypted' });
    expect([...(pending?.keys() ?? [])]).toEqual(['$new']);
  });

  it('clears when own membership appears, here or on another device', () => {
    const c = clients['@me:hs'];
    live(c, ringEv());
    c.emit('RoomState.events', memberEv('@bob:hs', { memberships: [{}] }));
    expect(service.incomingRing()).not.toBeNull();
    c.emit('RoomState.events', memberEv('@me:hs', { memberships: [{}] }));
    expect(service.incomingRing()).toBeNull();
  });

  it('clears on an own decline of that ring only', () => {
    const c = clients['@me:hs'];
    live(c, ringEv());
    const decline = (sender: string, target: string): Fake => ({
      type: DECLINE,
      id: '$d',
      sender,
      room: '!dm:hs',
      content: { 'm.relates_to': { event_id: target } },
    });
    live(c, decline('@me:hs', '$other'));
    live(c, decline('@bob:hs', '$ring'));
    expect(service.incomingRing()).not.toBeNull();
    live(c, decline('@me:hs', '$ring'));
    expect(service.incomingRing()).toBeNull();
  });

  it('lets a second ring replace the first without its timer clearing it', () => {
    const c = clients['@me:hs'];
    live(c, ringEv());
    vi.advanceTimersByTime(20_000);
    live(c, ringEv({ id: '$two' }, { sender_ts: NOW + 20_000 }));
    vi.advanceTimersByTime(10_000);
    expect(service.incomingRing()?.id).toBe('$two');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('declines through the ring account client', () => {
    accountIds.set(['@me:hs', '@you:hs']);
    TestBed.tick();
    live(clients['@you:hs'], ringEv());
    expect(service.incomingRing()?.accountId).toBe('@you:hs');
    activeUserId.set('@you:hs');
    activeUserId.set('@me:hs');
    expect(service.incomingRing()).not.toBeNull();
    service.decline();
    expect(clients['@you:hs'].sendEvent).toHaveBeenCalledWith(
      '!dm:hs',
      DECLINE,
      {
        'm.relates_to': { rel_type: 'm.reference', event_id: '$ring' },
      },
    );
    expect(clients['@me:hs'].sendEvent).not.toHaveBeenCalled();
    expect(service.incomingRing()).toBeNull();
  });

  it('clears and unbinds when the account signs out', () => {
    accountIds.set(['@me:hs', '@you:hs']);
    TestBed.tick();
    live(clients['@you:hs'], ringEv());
    accountIds.set(['@me:hs']);
    TestBed.tick();
    expect(service.incomingRing()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    live(clients['@you:hs'], ringEv({ id: '$again' }));
    expect(service.incomingRing()).toBeNull();
  });
});
