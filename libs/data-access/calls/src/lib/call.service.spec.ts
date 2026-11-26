import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { Observable, firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallSession, CallSessionState } from './call-runtime';
import { CALL_RUNTIME_LOAD_TIMEOUT_MS, CallService } from './call.service';

const runtime = vi.hoisted(() => ({
  sessions: [] as {
    state: { (): CallSessionState; set(v: CallSessionState): void };
    hangUp: ReturnType<typeof vi.fn>;
    onEnded: () => void;
  }[],
  start: vi.fn(),
  members: [] as unknown[],
  gate: null as Promise<void> | null,
  listeners: new Set<(event: unknown) => void>(),
  advertisedRtcTransports: vi.fn(),
  reads: 0,
}));

vi.mock('./call-runtime', async () => {
  if (runtime.gate) await runtime.gate;
  const { signal } = await import('@angular/core');
  runtime.start.mockImplementation((...args: unknown[]) => {
    const state = signal<CallSessionState>('loading');
    const session = {
      state,
      hangUp: vi.fn(),
      onEnded: args[4] as () => void,
    };
    runtime.sessions.push(session);
    return session as unknown as CallSession;
  });
  return { startCallSession: runtime.start };
});

vi.mock('./matrix-call-transport', () => ({
  matrixCallTransport: (_client: unknown, roomId: string) => ({
    roomId,
    userId: '@me:hs',
    deviceId: 'DEV',
    homeserverUrl: 'https://hs',
    readState: () => {
      runtime.reads++;
      return runtime.members;
    },
    roomEvents: () =>
      new Observable((subscriber) => {
        const listener = (event: unknown) => subscriber.next(event);
        runtime.listeners.add(listener);
        return () => runtime.listeners.delete(listener);
      }),
    advertisedRtcTransports: () => runtime.advertisedRtcTransports(),
  }),
}));

describe('CallService', () => {
  const activeUserId = signal<string | null>('@me:hs');
  const hasClient = signal(true);
  const client = {};
  const iframe = document.createElement('iframe');

  beforeEach(() => {
    vi.resetModules();
    runtime.gate = null;
    runtime.sessions.length = 0;
    runtime.members = [];
    runtime.listeners.clear();
    runtime.reads = 0;
    runtime.advertisedRtcTransports.mockReset();
    runtime.start.mockClear();
    activeUserId.set('@me:hs');
    hasClient.set(true);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MatrixClientService,
          useValue: {
            activeUserId,
            clientFor: () => (hasClient() ? client : null),
          },
        },
      ],
    });
  });

  // The service's import began earlier on the same module promise, so its continuation has run.
  const loaded = async () => {
    await import('./call-runtime');
    await Promise.resolve();
  };

  const opts = {
    video: true,
    dm: false,
    theme: 'dark',
    roomName: 'General',
  } as const;

  it('starts a call in the loading state', () => {
    const service = TestBed.inject(CallService);
    service.start('!r', opts);
    const call = service.activeCall();
    expect(call).toMatchObject({
      roomId: '!r',
      roomName: 'General',
      accountId: '@me:hs',
      state: 'loading',
      joinedAt: null,
    });
    expect(new URL(call!.widgetUrl).searchParams.get('intent')).toBe(
      'start_call',
    );
  });

  it('joins an existing call when a live member event exists', () => {
    runtime.members = [
      {
        type: 'org.matrix.msc3401.call.member',
        origin_server_ts: 0,
        content: { memberships: [{}] },
      },
    ];
    const service = TestBed.inject(CallService);
    service.start('!r', opts);
    expect(
      new URL(service.activeCall()!.widgetUrl).searchParams.get('intent'),
    ).toBe('join_existing');
  });

  it('does nothing without a client for the active account', () => {
    hasClient.set(false);
    const service = TestBed.inject(CallService);
    expect(() => service.start('!r', opts)).not.toThrow();
    expect(service.activeCall()).toBeNull();
  });

  it('gives each started call its own id, even in the same room', () => {
    const service = TestBed.inject(CallService);
    service.start('!r', opts);
    const first = service.activeCall()!.id;
    service.start('!r', opts);
    expect(service.activeCall()!.id).not.toBe(first);
  });

  it('keeps the id while the call state changes', async () => {
    const service = TestBed.inject(CallService);
    service.start('!r', opts);
    const id = service.activeCall()!.id;
    service.attach(iframe).subscribe();
    await loaded();
    runtime.sessions[0].state.set('joined');
    expect(service.activeCall()).toMatchObject({ id, state: 'joined' });
  });

  it('keeps the current call and its id when a start does nothing', () => {
    const service = TestBed.inject(CallService);
    service.start('!A', opts);
    const id = service.activeCall()!.id;
    hasClient.set(false);
    service.start('!B', opts);
    expect(service.activeCall()).toMatchObject({ id, roomId: '!A' });
  });

  it('hangs up the current call before starting another room', async () => {
    const service = TestBed.inject(CallService);
    service.start('!A', opts);
    service.attach(iframe).subscribe();
    await loaded();
    expect(runtime.sessions).toHaveLength(1);
    service.start('!B', opts);
    expect(runtime.sessions[0].hangUp).toHaveBeenCalled();
    // Element Call must leave before its frame goes, so the next call waits for it.
    expect(service.activeCall()).toMatchObject({
      roomId: '!A',
      state: 'ending',
    });
    runtime.sessions[0].onEnded();
    expect(service.activeCall()).toMatchObject({
      roomId: '!B',
      state: 'loading',
    });
    service.attach(iframe).subscribe();
    await loaded();
    expect(runtime.sessions).toHaveLength(2);
  });

  it('keeps the call ending until Element Call has left after a hang-up', async () => {
    const service = TestBed.inject(CallService);
    service.start('!r', opts);
    service.attach(iframe).subscribe();
    await loaded();
    const id = service.activeCall()!.id;
    runtime.sessions[0].state.set('joined');
    service.hangUp();
    expect(runtime.sessions[0].hangUp).toHaveBeenCalledTimes(1);
    expect(service.activeCall()).toMatchObject({ id, state: 'ending' });
    runtime.sessions[0].onEnded();
    expect(service.activeCall()).toBeNull();
  });

  it('starts only the latest call queued behind an ending one', async () => {
    const service = TestBed.inject(CallService);
    service.start('!A', opts);
    service.attach(iframe).subscribe();
    await loaded();
    service.start('!B', opts);
    service.start('!C', opts);
    runtime.sessions[0].onEnded();
    expect(service.activeCall()?.roomId).toBe('!C');
  });

  it('clears at once a call hung up before its session started', () => {
    runtime.gate = new Promise<void>(() => undefined);
    const service = TestBed.inject(CallService);
    service.start('!r', opts);
    service.attach(iframe).subscribe();
    service.hangUp();
    expect(service.activeCall()).toBeNull();
  });

  it('keeps a failed call until the user closes it', async () => {
    const service = TestBed.inject(CallService);
    service.start('!r', opts);
    service.attach(iframe).subscribe();
    await loaded();
    runtime.sessions[0].state.set('failed');
    runtime.sessions[0].onEnded();
    expect(service.activeCall()?.state).toBe('failed');
    service.hangUp();
    expect(service.activeCall()).toBeNull();
  });

  it('binds the widget, mirrors session state and clears on end', async () => {
    const service = TestBed.inject(CallService);
    service.start('!r', opts);
    const done = firstValueFrom(service.attach(iframe), {
      defaultValue: null,
    });
    await loaded();
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(runtime.start.mock.calls[0][1]).toBe(
      service.activeCall()!.widgetUrl,
    );
    expect(runtime.start.mock.calls[0][2]).toBe('trinity-call');
    expect(runtime.start.mock.calls[0][3]).toBe(iframe);
    runtime.sessions[0].state.set('joined');
    expect(service.activeCall()?.state).toBe('joined');
    runtime.sessions[0].onEnded();
    await done;
    expect(service.activeCall()).toBeNull();
  });

  it('hangs up when the attach subscription is dropped', async () => {
    const service = TestBed.inject(CallService);
    service.start('!r', opts);
    const subscription = service.attach(iframe).subscribe();
    await loaded();
    expect(runtime.sessions).toHaveLength(1);
    subscription.unsubscribe();
    expect(runtime.sessions[0].hangUp).toHaveBeenCalled();
  });

  it.each([['@you:hs'], [null]])(
    'ends the call when the account changes to %s',
    async (next) => {
      const service = TestBed.inject(CallService);
      service.start('!r', opts);
      service.attach(iframe).subscribe();
      await loaded();
      expect(runtime.sessions).toHaveLength(1);
      activeUserId.set(next);
      TestBed.tick();
      expect(runtime.sessions[0].hangUp).toHaveBeenCalled();
      expect(service.activeCall()?.state).toBe('ending');
      runtime.sessions[0].onEnded();
      expect(service.activeCall()).toBeNull();
    },
  );

  it('starts one session for a second attach after the first bound', async () => {
    const service = TestBed.inject(CallService);
    service.start('!r', opts);
    service.attach(iframe).subscribe();
    await loaded();
    expect(runtime.sessions).toHaveLength(1);
    service.attach(iframe).subscribe();
    await loaded();
    expect(runtime.start).toHaveBeenCalledTimes(1);
  });

  it('starts one session for two concurrent attaches', async () => {
    let open!: () => void;
    runtime.gate = new Promise<void>((resolve) => (open = resolve));
    const service = TestBed.inject(CallService);
    service.start('!r', opts);
    service.attach(iframe).subscribe();
    service.attach(iframe).subscribe();
    open();
    await loaded();
    expect(runtime.start).toHaveBeenCalledTimes(1);
  });

  it('clears the call when the bound subscription is dropped', async () => {
    const service = TestBed.inject(CallService);
    service.start('!r', opts);
    const subscription = service.attach(iframe).subscribe();
    await loaded();
    subscription.unsubscribe();
    expect(runtime.sessions[0].hangUp).toHaveBeenCalledTimes(1);
    expect(service.activeCall()).toBeNull();
  });

  it('ends the call when attach is dropped before the chunk resolves', async () => {
    let open!: () => void;
    runtime.gate = new Promise<void>((resolve) => (open = resolve));
    const service = TestBed.inject(CallService);
    service.start('!r', opts);
    service.attach(iframe).subscribe().unsubscribe();
    expect(service.activeCall()).toBeNull();
    open();
    await loaded();
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it('starts no session when the account changes while the chunk loads', async () => {
    let open!: () => void;
    runtime.gate = new Promise<void>((resolve) => (open = resolve));
    const service = TestBed.inject(CallService);
    service.start('!r', opts);
    service.attach(iframe).subscribe();
    activeUserId.set('@you:hs');
    open();
    await loaded();
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it('fails the call when the runtime chunk times out', () => {
    vi.useFakeTimers();
    try {
      runtime.gate = new Promise<void>(() => undefined);
      const service = TestBed.inject(CallService);
      service.start('!r', opts);
      service.attach(iframe).subscribe();
      vi.advanceTimersByTime(CALL_RUNTIME_LOAD_TIMEOUT_MS);
      expect(service.activeCall()?.state).toBe('failed');
    } finally {
      vi.useRealTimers();
    }
  });

  // Leaving the rooms page during the ending still drops the frame (slice 1).
  it('sends one hang-up when ending then dropping the subscription', async () => {
    const service = TestBed.inject(CallService);
    service.start('!r', opts);
    const subscription = service.attach(iframe).subscribe();
    await loaded();
    expect(runtime.sessions).toHaveLength(1);
    service.hangUp();
    subscription.unsubscribe();
    expect(runtime.sessions[0].hangUp).toHaveBeenCalledTimes(1);
    expect(service.activeCall()).toBeNull();
  });

  describe('joinedAt', () => {
    afterEach(() => vi.useRealTimers());

    it('is set once the session joins and does not move afterwards', async () => {
      vi.useFakeTimers({ now: 10_000, toFake: ['Date'] });
      const service = TestBed.inject(CallService);
      service.start('!r', opts);
      service.attach(iframe).subscribe();
      await loaded();
      TestBed.tick();
      expect(service.activeCall()?.joinedAt).toBeNull();

      runtime.sessions[0].state.set('joined');
      TestBed.tick();
      expect(service.activeCall()?.joinedAt).toBe(10_000);

      vi.setSystemTime(20_000);
      TestBed.tick();
      expect(service.activeCall()?.joinedAt).toBe(10_000);
    });

    it('starts over for the next call', async () => {
      vi.useFakeTimers({ now: 10_000, toFake: ['Date'] });
      const service = TestBed.inject(CallService);
      service.start('!r', opts);
      service.attach(iframe).subscribe();
      await loaded();
      runtime.sessions[0].state.set('joined');
      TestBed.tick();
      service.start('!r', opts);
      runtime.sessions[0].onEnded();
      TestBed.tick();
      expect(service.activeCall()).toMatchObject({
        state: 'loading',
        joinedAt: null,
      });
    });
  });

  describe('elapsed', () => {
    afterEach(() => vi.useRealTimers());

    it('is empty before the join, then counts seconds, and leaves no timer', async () => {
      vi.useFakeTimers({ now: 10_000 });
      const service = TestBed.inject(CallService);
      service.start('!r', opts);
      service.attach(iframe).subscribe();
      await loaded();
      const seen: string[] = [];
      const subscription = service.elapsed().subscribe((v) => seen.push(v));
      vi.advanceTimersByTime(0);
      expect(seen).toEqual(['']);

      runtime.sessions[0].state.set('joined');
      TestBed.tick();
      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(1000);
      expect(seen).toEqual(['', '0:01', '0:02']);

      subscription.unsubscribe();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('participants', () => {
    const member = (content: Record<string, unknown>) => ({
      type: 'org.matrix.msc3401.call.member',
      origin_server_ts: 0,
      content,
    });
    const emit = (event: unknown) =>
      runtime.listeners.forEach((listener) => listener(event));

    it('tracks joins and expiries', () => {
      vi.useFakeTimers({ now: 1_000 });
      try {
        runtime.members = [member({ expires_ts: 5_000 })];
        const counts: number[] = [];
        const subscription = TestBed.inject(CallService)
          .participants('@me:hs', '!r')
          .subscribe((count) => counts.push(count));
        expect(counts).toEqual([1]);
        runtime.members = [
          member({ expires_ts: 5_000 }),
          member({ expires_ts: 60_000 }),
        ];
        emit(member({ expires_ts: 60_000 }));
        expect(counts).toEqual([1, 2]);
        vi.advanceTimersByTime(4_001);
        expect(counts).toEqual([1, 2, 1]);
        subscription.unsubscribe();
        expect(runtime.listeners.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not spin on an expiry beyond the timer limit', () => {
      vi.useFakeTimers({ now: 1_000 });
      try {
        runtime.members = [member({ expires_ts: Date.now() + 3e10 })];
        const counts: number[] = [];
        const subscription = TestBed.inject(CallService)
          .participants('@me:hs', '!r')
          .subscribe((count) => counts.push(count));
        vi.advanceTimersByTime(1_000);
        expect(counts).toEqual([1]);
        expect(runtime.reads).toBe(1);
        subscription.unsubscribe();
      } finally {
        vi.useRealTimers();
      }
    });

    it('ignores other event types', () => {
      runtime.members = [member({ expires_ts: Date.now() + 60_000 })];
      const counts: number[] = [];
      TestBed.inject(CallService)
        .participants('@me:hs', '!r')
        .subscribe((count) => counts.push(count));
      emit({ type: 'm.room.message', content: {} });
      expect(counts).toEqual([1]);
    });

    it('emits 0 and completes for an unknown account', () => {
      hasClient.set(false);
      const counts: number[] = [];
      let completed = false;
      TestBed.inject(CallService)
        .participants('@nobody:hs', '!r')
        .subscribe({
          next: (count) => counts.push(count),
          complete: () => (completed = true),
        });
      expect(counts).toEqual([0]);
      expect(completed).toBe(true);
    });
  });

  describe('callAvailable', () => {
    it('turns false when the server has no transports', async () => {
      runtime.advertisedRtcTransports.mockResolvedValue([]);
      const values: boolean[] = [];
      TestBed.inject(CallService)
        .callAvailable('@me:hs', '!r')
        .subscribe((value) => values.push(value));
      expect(values).toEqual([true]);
      await Promise.resolve();
      await Promise.resolve();
      expect(values).toEqual([true, false]);
    });

    it('stays true when the server lacks the endpoint', async () => {
      runtime.advertisedRtcTransports.mockResolvedValue(undefined);
      const values: boolean[] = [];
      TestBed.inject(CallService)
        .callAvailable('@me:hs', '!r')
        .subscribe((value) => values.push(value));
      await Promise.resolve();
      await Promise.resolve();
      expect(values).toEqual([true]);
    });

    it('stays true when the lookup fails', async () => {
      runtime.advertisedRtcTransports.mockRejectedValue(new Error('down'));
      const values: boolean[] = [];
      TestBed.inject(CallService)
        .callAvailable('@me:hs', '!r')
        .subscribe((value) => values.push(value));
      await Promise.resolve();
      await Promise.resolve();
      expect(values).toEqual([true]);
    });

    it('looks up once per account', async () => {
      runtime.advertisedRtcTransports.mockResolvedValue([{}]);
      const service = TestBed.inject(CallService);
      service.callAvailable('@me:hs', '!a').subscribe();
      service.callAvailable('@me:hs', '!b').subscribe();
      expect(runtime.advertisedRtcTransports).toHaveBeenCalledTimes(1);
    });
  });
});
