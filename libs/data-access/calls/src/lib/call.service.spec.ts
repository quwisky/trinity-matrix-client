import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    readState: () => runtime.members,
  }),
}));

describe('CallService', () => {
  const activeUserId = signal<string | null>('@me:hs');
  const hasClient = signal(true);
  const iframe = document.createElement('iframe');

  beforeEach(() => {
    vi.resetModules();
    runtime.gate = null;
    runtime.sessions.length = 0;
    runtime.members = [];
    runtime.start.mockClear();
    activeUserId.set('@me:hs');
    hasClient.set(true);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MatrixClientService,
          useValue: {
            activeUserId,
            clientFor: () => (hasClient() ? {} : null),
          },
        },
      ],
    });
  });

  const opts = { video: true, dm: false, theme: 'dark' } as const;

  it('starts a call in the loading state', () => {
    const service = TestBed.inject(CallService);
    service.start('!r', opts);
    const call = service.activeCall();
    expect(call).toMatchObject({
      roomId: '!r',
      accountId: '@me:hs',
      state: 'loading',
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

  it('hangs up the current call before starting another room', async () => {
    const service = TestBed.inject(CallService);
    service.start('!A', opts);
    service.attach(iframe).subscribe();
    await vi.waitFor(() => expect(runtime.sessions).toHaveLength(1));
    service.start('!B', opts);
    expect(runtime.sessions[0].hangUp).toHaveBeenCalled();
    expect(service.activeCall()?.roomId).toBe('!B');
    runtime.sessions[0].onEnded();
    expect(service.activeCall()?.roomId).toBe('!B');
  });

  it('binds the widget, mirrors session state and clears on end', async () => {
    const service = TestBed.inject(CallService);
    service.start('!r', opts);
    const done = firstValueFrom(service.attach(iframe), {
      defaultValue: null,
    });
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(1));
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
    await vi.waitFor(() => expect(runtime.sessions).toHaveLength(1));
    subscription.unsubscribe();
    expect(runtime.sessions[0].hangUp).toHaveBeenCalled();
  });

  it.each([['@you:hs'], [null]])(
    'ends the call when the account changes to %s',
    async (next) => {
      const service = TestBed.inject(CallService);
      service.start('!r', opts);
      service.attach(iframe).subscribe();
      await vi.waitFor(() => expect(runtime.sessions).toHaveLength(1));
      activeUserId.set(next);
      TestBed.tick();
      expect(runtime.sessions[0].hangUp).toHaveBeenCalled();
      expect(service.activeCall()).toBeNull();
    },
  );

  it('starts one session for two attaches of the same call', async () => {
    const service = TestBed.inject(CallService);
    service.start('!r', opts);
    service.attach(iframe).subscribe();
    service.attach(iframe).subscribe();
    await vi.waitFor(() => expect(runtime.sessions).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.start).toHaveBeenCalledTimes(1);
  });

  it('ends the call when attach is dropped before the chunk resolves', async () => {
    let open!: () => void;
    runtime.gate = new Promise<void>((resolve) => (open = resolve));
    const service = TestBed.inject(CallService);
    service.start('!r', opts);
    service.attach(iframe).subscribe().unsubscribe();
    expect(service.activeCall()).toBeNull();
    open();
    await new Promise((resolve) => setTimeout(resolve, 20));
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
    await new Promise((resolve) => setTimeout(resolve, 20));
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

  it('sends one hang-up when ending then dropping the subscription', async () => {
    const service = TestBed.inject(CallService);
    service.start('!r', opts);
    const subscription = service.attach(iframe).subscribe();
    await vi.waitFor(() => expect(runtime.sessions).toHaveLength(1));
    service.hangUp();
    subscription.unsubscribe();
    expect(runtime.sessions[0].hangUp).toHaveBeenCalledTimes(1);
    expect(service.activeCall()).toBeNull();
  });
});
