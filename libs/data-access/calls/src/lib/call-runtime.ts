import { signal, type Signal } from '@angular/core';
import {
  ClientWidgetApi,
  Widget,
  WidgetApiFromWidgetAction,
  type IWidgetApiRequest,
} from 'matrix-widget-api';
import type { Subscription } from 'rxjs';
import { callCapabilities } from './call-capabilities';
import type { CallTransport } from './call-transport';
import { CallWidgetDriver, toRoomEvent } from './call-widget-driver';

/*
 * With call-widget-driver.ts, the only modules in the calls library that import
 * matrix-widget-api. Callers load this one with a dynamic `import()`, so the Widget
 * API stays out of the initial bundle.
 */

export type CallSessionState = 'loading' | 'joined' | 'ended' | 'failed';

export interface CallSession {
  readonly state: Signal<CallSessionState>;
  hangUp(): void;
}

/*
 * Element Call 0.28 (CallViewModel, CallView) answers a host hang-up at once, then leaves:
 * it sends its membership leave and `im.vector.hangup` together, plays the leave sound and
 * only then sends `io.element.close`, its signal that the host may dispose of it. Its own
 * hang-up takes the same path. So the session ends on the close, not on either hang-up.
 */
const CLOSE_ACTION = 'io.element.close';
const HANGUP_ACTION = 'im.vector.hangup';
/** Sent once Element Call enters the call, before it reaches its media service. */
const JOIN_ACTION = 'io.element.join';
const ALWAYS_ON_SCREEN_ACTION = 'set_always_on_screen';
const DEVICE_MUTE_ACTION = 'io.element.device_mute';

/** How long Element Call may take to report `content_loaded` before the call fails. */
export const CALL_LOAD_TIMEOUT_MS = 25_000;

/** How long Element Call may take, once hung up, to leave and ask to be closed. */
export const CALL_LEAVE_TIMEOUT_MS = 10_000;

/**
 * How long Element Call may take, once it gives up always-on-screen without a hang-up, to ask
 * to be closed. On a fatal error (LiveKit or its token service unreachable) it never asks.
 */
export const CALL_CLOSE_GRACE_MS = 2_000;

/** Bind a call-scoped client Widget API to a frame, then load Element Call into it. */
export function startCallSession(
  transport: CallTransport,
  widgetUrl: string,
  widgetId: string,
  iframe: HTMLIFrameElement,
  onEnded: () => void,
): CallSession {
  const allowed = callCapabilities(
    transport.roomId,
    transport.userId,
    transport.deviceId,
  );
  const widget = new Widget({
    id: widgetId,
    type: 'm.call',
    creatorUserId: transport.userId,
    url: widgetUrl,
    waitForIframeLoad: false,
  });
  const api = new ClientWidgetApi(
    widget,
    iframe,
    new CallWidgetDriver(transport, allowed),
  );
  api.setViewedRoomId(transport.roomId);
  const session = new ActiveCallSession(api, transport, allowed, onEnded);
  iframe.src = widgetUrl;
  return session;
}

/** The widget may reject a fed event it cannot handle; the call carries on regardless. */
const ignore = (): void => undefined;

class ActiveCallSession implements CallSession {
  private readonly currentState = signal<CallSessionState>('loading');
  private readonly subscriptions: Subscription[];
  private finished = false;
  private joinedCall = false;
  private hungUp = false;
  private readonly loadTimer = setTimeout(
    () => this.finish('failed'),
    CALL_LOAD_TIMEOUT_MS,
  );
  private leaveTimer: ReturnType<typeof setTimeout> | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly onContentLoaded = (): void => {
    clearTimeout(this.loadTimer);
    if (!this.finished) this.currentState.set('joined');
  };
  private readonly onClose = (ev: CustomEvent<IWidgetApiRequest>): void => {
    this.answer(ev);
    this.finish(this.joinedCall || this.hungUp ? 'ended' : 'failed');
  };
  private readonly onWidgetHangUp = (
    ev: CustomEvent<IWidgetApiRequest>,
  ): void => {
    this.answer(ev);
    this.hungUp = true;
    this.awaitLeave();
  };
  private readonly onJoin = (ev: CustomEvent<IWidgetApiRequest>): void => {
    this.answer(ev);
    this.joinedCall = true;
    this.onContentLoaded();
  };
  private readonly onAlwaysOnScreen = (
    ev: CustomEvent<IWidgetApiRequest>,
  ): void => {
    this.answer(ev);
    if (ev.detail.data['value'] !== false) {
      clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    } else if (!this.hungUp && !this.finished) {
      this.closeTimer ??= setTimeout(() => {
        if (!this.hungUp) this.finish('failed');
      }, CALL_CLOSE_GRACE_MS);
    }
  };
  private readonly onDeviceMute = (ev: CustomEvent<IWidgetApiRequest>): void =>
    this.answer(ev);
  private readonly onPreparingError = (): void => this.finish('failed');

  readonly state = this.currentState.asReadonly();

  constructor(
    private readonly api: ClientWidgetApi,
    transport: CallTransport,
    allowed: ReadonlySet<string>,
    private readonly onEnded: () => void,
  ) {
    this.subscriptions = [
      transport.roomEvents().subscribe((event) => {
        const roomEvent = toRoomEvent(event);
        api.feedEvent(roomEvent).catch(ignore);
        if (event.state_key !== undefined) {
          api.feedStateUpdate(roomEvent).catch(ignore);
        }
      }),
      transport.toDevice().subscribe(({ type, sender, content, encrypted }) => {
        if (allowed.has(`org.matrix.msc3819.receive.to_device:${type}`)) {
          api.feedToDevice({ type, sender, content }, encrypted).catch(ignore);
        }
      }),
    ];
    api.on(
      `action:${WidgetApiFromWidgetAction.ContentLoaded}`,
      this.onContentLoaded,
    );
    for (const [action, listener] of this.actionListeners()) {
      api.on(`action:${action}`, listener);
    }
    api.on('error:preparing', this.onPreparingError);
  }

  hangUp(): void {
    if (this.finished) return;
    this.hungUp = true;
    clearTimeout(this.loadTimer);
    // A widget that cannot answer cannot leave either, so end at once.
    this.api.transport.send(HANGUP_ACTION, {}).then(
      () => this.awaitLeave(),
      () => this.finish('ended'),
    );
  }

  private actionListeners(): [
    string,
    (ev: CustomEvent<IWidgetApiRequest>) => void,
  ][] {
    return [
      [CLOSE_ACTION, this.onClose],
      [HANGUP_ACTION, this.onWidgetHangUp],
      [JOIN_ACTION, this.onJoin],
      [ALWAYS_ON_SCREEN_ACTION, this.onAlwaysOnScreen],
      [DEVICE_MUTE_ACTION, this.onDeviceMute],
    ];
  }

  /** Claims a widget request so ClientWidgetApi does not also reject it as unsupported. */
  private answer(ev: CustomEvent<IWidgetApiRequest>): void {
    ev.preventDefault();
    this.api.transport.reply(ev.detail, {});
  }

  private awaitLeave(): void {
    if (this.finished || this.leaveTimer !== undefined) return;
    this.leaveTimer = setTimeout(
      () => this.finish('ended'),
      CALL_LEAVE_TIMEOUT_MS,
    );
  }

  private finish(state: 'ended' | 'failed'): void {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.loadTimer);
    clearTimeout(this.leaveTimer);
    clearTimeout(this.closeTimer);
    this.currentState.set(state);
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    this.api.removeListener(
      `action:${WidgetApiFromWidgetAction.ContentLoaded}`,
      this.onContentLoaded,
    );
    for (const [action, listener] of this.actionListeners()) {
      this.api.removeListener(`action:${action}`, listener);
    }
    this.api.removeListener('error:preparing', this.onPreparingError);
    this.api.stop();
    this.onEnded();
  }
}
