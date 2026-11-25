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

/** How long Element Call may take to report `content_loaded` before the call fails. */
export const CALL_LOAD_TIMEOUT_MS = 25_000;

/** How long Element Call may take, once hung up, to leave and ask to be closed. */
export const CALL_LEAVE_TIMEOUT_MS = 10_000;

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
  private readonly loadTimer = setTimeout(
    () => this.finish('failed'),
    CALL_LOAD_TIMEOUT_MS,
  );
  private leaveTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly onContentLoaded = (): void => {
    clearTimeout(this.loadTimer);
    if (!this.finished) this.currentState.set('joined');
  };
  private readonly onClose = (ev: CustomEvent<IWidgetApiRequest>): void => {
    ev.preventDefault();
    this.api.transport.reply(ev.detail, {});
    this.finish('ended');
  };
  private readonly onWidgetHangUp = (
    ev: CustomEvent<IWidgetApiRequest>,
  ): void => {
    ev.preventDefault();
    this.api.transport.reply(ev.detail, {});
    this.awaitLeave();
  };
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
    api.on(`action:${CLOSE_ACTION}`, this.onClose);
    api.on(`action:${HANGUP_ACTION}`, this.onWidgetHangUp);
    api.on('error:preparing', this.onPreparingError);
  }

  hangUp(): void {
    if (this.finished) return;
    clearTimeout(this.loadTimer);
    // A widget that cannot answer cannot leave either, so end at once.
    this.api.transport.send(HANGUP_ACTION, {}).then(
      () => this.awaitLeave(),
      () => this.finish('ended'),
    );
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
    this.currentState.set(state);
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    this.api.removeListener(
      `action:${WidgetApiFromWidgetAction.ContentLoaded}`,
      this.onContentLoaded,
    );
    this.api.removeListener(`action:${CLOSE_ACTION}`, this.onClose);
    this.api.removeListener(`action:${HANGUP_ACTION}`, this.onWidgetHangUp);
    this.api.removeListener('error:preparing', this.onPreparingError);
    this.api.stop();
    this.onEnded();
  }
}
