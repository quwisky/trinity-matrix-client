import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CallToDevice,
  CallTransport,
  RawCallEvent,
} from './call-transport';
import {
  CALL_CLOSE_GRACE_MS,
  CALL_LEAVE_TIMEOUT_MS,
  CALL_LOAD_TIMEOUT_MS,
  startCallSession,
} from './call-runtime';

const { FakeClientWidgetApi, apis } = vi.hoisted(() => {
  class FakeClientWidgetApi {
    readonly listeners = new Map<string, ((ev: CustomEvent) => void)[]>();
    readonly feedEvent = vi.fn().mockResolvedValue(undefined);
    readonly feedStateUpdate = vi.fn().mockResolvedValue(undefined);
    readonly feedToDevice = vi.fn().mockResolvedValue(undefined);
    readonly setViewedRoomId = vi.fn();
    readonly stop = vi.fn();
    readonly transport = {
      send: vi.fn().mockResolvedValue({}),
      reply: vi.fn(),
    };

    constructor(
      readonly widget: unknown,
      readonly iframe: HTMLIFrameElement,
      readonly driver: unknown,
    ) {
      apis.push(this);
    }

    on(name: string, listener: (ev: CustomEvent) => void): this {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
      return this;
    }

    removeListener(name: string, listener: (ev: CustomEvent) => void): this {
      this.listeners.set(
        name,
        (this.listeners.get(name) ?? []).filter((l) => l !== listener),
      );
      return this;
    }

    /** Mirrors ClientWidgetApi: an `action:*` CustomEvent the listener may cancel. */
    fromWidget(action: string, data: object = {}): CustomEvent {
      const ev = new CustomEvent(`action:${action}`, {
        detail: {
          api: 'fromWidget',
          widgetId: 'w',
          requestId: 'r',
          action,
          data,
        },
        cancelable: true,
      });
      for (const listener of this.listeners.get(`action:${action}`) ?? []) {
        listener(ev);
      }
      return ev;
    }
  }
  const apis: FakeClientWidgetApi[] = [];
  return { FakeClientWidgetApi, apis };
});

vi.mock('matrix-widget-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('matrix-widget-api')>()),
  ClientWidgetApi: FakeClientWidgetApi,
}));

const roomEvent = (extra: Partial<RawCallEvent> = {}): RawCallEvent => ({
  type: 'io.element.call.reaction',
  event_id: '$e',
  room_id: '!r:hs',
  sender: '@b:hs',
  origin_server_ts: 1,
  content: {},
  ...extra,
});

function setup() {
  const roomEvents = new Subject<RawCallEvent>();
  const toDevice = new Subject<CallToDevice>();
  const transport = {
    roomId: '!r:hs',
    userId: '@a:hs',
    deviceId: 'DEV',
    homeserverUrl: 'https://hs',
    roomEvents: () => roomEvents,
    toDevice: () => toDevice,
  } as unknown as CallTransport;
  const iframe = document.createElement('iframe');
  const onEnded = vi.fn();
  const url = 'https://app.test/element-call/index.html?widgetId=w';
  const session = startCallSession(transport, url, 'w', iframe, onEnded);
  const api = apis.at(-1)!;
  return { roomEvents, toDevice, iframe, onEnded, url, session, api };
}

describe('startCallSession', () => {
  afterEach(() => {
    apis.length = 0;
  });

  it('binds the API to the call room before the frame loads', () => {
    const { api, iframe, url, session } = setup();

    expect(api.iframe).toBe(iframe);
    expect(api.setViewedRoomId).toHaveBeenCalledWith('!r:hs');
    expect(api.widget).toMatchObject({
      id: 'w',
      type: 'm.call',
      creatorUserId: '@a:hs',
      waitForIframeLoad: false,
    });
    expect(iframe.src).toBe(url);
    expect(session.state()).toBe('loading');
  });

  it('feeds room events, and state events as state updates too', () => {
    const { roomEvents, api } = setup();
    const message = roomEvent();
    const state = roomEvent({
      type: 'org.matrix.msc3401.call.member',
      state_key: '@b:hs',
    });

    roomEvents.next(message);
    roomEvents.next(state);

    expect(api.feedEvent).toHaveBeenCalledWith({ ...message, unsigned: {} });
    expect(api.feedEvent).toHaveBeenCalledWith({ ...state, unsigned: {} });
    expect(api.feedStateUpdate).toHaveBeenCalledTimes(1);
    expect(api.feedStateUpdate).toHaveBeenCalledWith({
      ...state,
      unsigned: {},
    });
  });

  it('feeds only the listed to-device types', () => {
    const { toDevice, api } = setup();
    const keys = {
      type: 'io.element.call.encryption_keys',
      sender: '@b:hs',
      content: { keys: [] },
      encrypted: true,
    };

    toDevice.next(keys);
    toDevice.next({ ...keys, type: 'm.room_key_request' });

    expect(api.feedToDevice).toHaveBeenCalledTimes(1);
    expect(api.feedToDevice).toHaveBeenCalledWith(
      { type: keys.type, sender: keys.sender, content: keys.content },
      true,
    );
  });

  it('marks the session joined once the frame reports its content loaded', () => {
    const { api, session } = setup();

    const ev = api.fromWidget('content_loaded');

    expect(ev.defaultPrevented).toBe(false);
    expect(session.state()).toBe('joined');
  });

  it.each([
    ['io.element.join', {}],
    ['set_always_on_screen', { value: true }],
    ['io.element.device_mute', { audio_enabled: true, video_enabled: true }],
  ])('answers %s with an empty reply', (action, data) => {
    const { api } = setup();

    const ev = api.fromWidget(action, data);

    expect(ev.defaultPrevented).toBe(true);
    expect(api.transport.reply).toHaveBeenCalledWith(ev.detail, {});
  });

  it('marks the session joined once Element Call joins the call', () => {
    vi.useFakeTimers();
    try {
      const { api, session } = setup();

      api.fromWidget('io.element.join');
      vi.advanceTimersByTime(CALL_LOAD_TIMEOUT_MS);

      expect(session.state()).toBe('joined');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a session that Element Call closes before joining', () => {
    const { api, session, onEnded } = setup();
    api.fromWidget('content_loaded');

    api.fromWidget('io.element.close');

    expect(session.state()).toBe('failed');
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('ends a session hung up before joining once Element Call closes', async () => {
    const { api, session } = setup();
    api.fromWidget('content_loaded');

    session.hangUp();
    await Promise.resolve();
    api.fromWidget('io.element.close');

    expect(session.state()).toBe('ended');
  });

  // Element Call 0.28 leaves on a fatal error without asking to close: it only gives up
  // always-on-screen and shows its own error screen.
  it('fails a joined session that stops showing without asking to close', () => {
    vi.useFakeTimers();
    try {
      const { api, session, onEnded } = setup();
      api.fromWidget('io.element.join');

      api.fromWidget('set_always_on_screen', { value: false });
      vi.advanceTimersByTime(CALL_CLOSE_GRACE_MS - 1);
      expect(session.state()).toBe('joined');
      vi.advanceTimersByTime(1);

      expect(session.state()).toBe('failed');
      expect(onEnded).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Element Call's Reconnect asks for always-on-screen again.
  it('keeps a session that shows again after it stopped showing', () => {
    vi.useFakeTimers();
    try {
      const { api, session } = setup();
      api.fromWidget('io.element.join');

      api.fromWidget('set_always_on_screen', { value: false });
      api.fromWidget('set_always_on_screen', { value: true });
      vi.advanceTimersByTime(CALL_CLOSE_GRACE_MS);

      expect(session.state()).toBe('joined');
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for the leave of a session hung up while it stopped showing', async () => {
    vi.useFakeTimers();
    try {
      const { api, session } = setup();
      api.fromWidget('io.element.join');

      api.fromWidget('set_always_on_screen', { value: false });
      session.hangUp();
      await vi.advanceTimersByTimeAsync(CALL_CLOSE_GRACE_MS);

      expect(session.state()).toBe('joined');
      api.fromWidget('io.element.close');
      expect(session.state()).toBe('ended');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a joined session that stops showing and then asks to close', () => {
    vi.useFakeTimers();
    try {
      const { api, session, onEnded } = setup();
      api.fromWidget('io.element.join');

      api.fromWidget('set_always_on_screen', { value: false });
      api.fromWidget('io.element.close');
      vi.advanceTimersByTime(CALL_CLOSE_GRACE_MS);

      expect(session.state()).toBe('ended');
      expect(onEnded).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps waiting for the leave of a hung-up session that stops showing', () => {
    vi.useFakeTimers();
    try {
      const { api, session } = setup();
      api.fromWidget('io.element.join');
      api.fromWidget('im.vector.hangup');

      api.fromWidget('set_always_on_screen', { value: false });
      vi.advanceTimersByTime(CALL_CLOSE_GRACE_MS);

      expect(session.state()).toBe('joined');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends the session when Element Call asks to be closed', () => {
    const { api, session, onEnded, roomEvents, toDevice } = setup();
    api.fromWidget('io.element.join');

    const ev = api.fromWidget('io.element.close');
    api.fromWidget('io.element.close');

    expect(ev.defaultPrevented).toBe(true);
    expect(api.transport.reply).toHaveBeenCalledWith(ev.detail, {});
    expect(session.state()).toBe('ended');
    expect(roomEvents.observed).toBe(false);
    expect(toDevice.observed).toBe(false);
    expect(api.stop).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  // Element Call sends its hang-up together with its leave, and asks to be closed after.
  it('keeps the session after Element Call reports its own hang-up until it asks to close', () => {
    const { api, session, onEnded } = setup();
    api.fromWidget('content_loaded');
    api.fromWidget('io.element.join');

    const ev = api.fromWidget('im.vector.hangup');

    expect(ev.defaultPrevented).toBe(true);
    expect(api.transport.reply).toHaveBeenCalledWith(ev.detail, {});
    expect(api.stop).not.toHaveBeenCalled();
    expect(session.state()).toBe('joined');
    api.fromWidget('io.element.close');
    expect(session.state()).toBe('ended');
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('ends a session whose widget hung up but never asks to close', () => {
    vi.useFakeTimers();
    try {
      const { api, onEnded } = setup();
      api.fromWidget('content_loaded');
      api.fromWidget('im.vector.hangup');

      vi.advanceTimersByTime(CALL_LEAVE_TIMEOUT_MS - 1);
      expect(api.stop).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);

      expect(api.stop).toHaveBeenCalledTimes(1);
      expect(onEnded).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails the session when capability negotiation fails', () => {
    const { api, session, onEnded } = setup();

    for (const listener of api.listeners.get('error:preparing') ?? []) {
      listener(new CustomEvent('error:preparing'));
    }

    expect(session.state()).toBe('failed');
    expect(api.stop).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('fails the session when the frame never reports its content loaded', () => {
    vi.useFakeTimers();
    try {
      const { session, onEnded, api } = setup();

      vi.advanceTimersByTime(CALL_LOAD_TIMEOUT_MS - 1);
      expect(session.state()).toBe('loading');
      vi.advanceTimersByTime(1);

      expect(session.state()).toBe('failed');
      expect(api.stop).toHaveBeenCalledTimes(1);
      expect(onEnded).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a loaded session past the load timeout', () => {
    vi.useFakeTimers();
    try {
      const { session, api } = setup();

      api.fromWidget('content_loaded');
      vi.advanceTimersByTime(CALL_LOAD_TIMEOUT_MS);

      expect(session.state()).toBe('joined');
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits after a hang-up reply for Element Call to leave and ask to close', async () => {
    const { api, session, onEnded } = setup();
    api.fromWidget('content_loaded');

    session.hangUp();
    await Promise.resolve();
    await Promise.resolve();

    expect(api.transport.send).toHaveBeenCalledWith('im.vector.hangup', {});
    expect(api.stop).not.toHaveBeenCalled();
    expect(session.state()).toBe('joined');
    api.fromWidget('io.element.close');
    expect(api.stop).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('ends a hung-up session that never asks to close', async () => {
    vi.useFakeTimers();
    try {
      const { api, session, onEnded } = setup();
      api.fromWidget('content_loaded');

      session.hangUp();
      await vi.advanceTimersByTimeAsync(CALL_LEAVE_TIMEOUT_MS - 1);
      expect(api.stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(session.state()).toBe('ended');
      expect(onEnded).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks the widget to hang up, then tears down at once if that fails', async () => {
    const { api, session, onEnded, roomEvents, toDevice } = setup();
    api.transport.send.mockRejectedValue(new Error('gone'));

    session.hangUp();

    expect(api.transport.send).toHaveBeenCalledWith('im.vector.hangup', {});
    await vi.waitFor(() => expect(api.stop).toHaveBeenCalledTimes(1));
    expect(session.state()).toBe('ended');
    expect(roomEvents.observed).toBe(false);
    expect(toDevice.observed).toBe(false);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });
});
