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

/** Element Call 0.28 reports its own hang-up with `io.element.close`. */
const WIDGET_CLOSE_ACTIONS = ['io.element.close', 'im.vector.hangup'];
const HANGUP_ACTION = 'im.vector.hangup';

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

  private readonly onContentLoaded = (): void => {
    if (!this.finished) this.currentState.set('joined');
  };
  private readonly onClose = (ev: CustomEvent<IWidgetApiRequest>): void => {
    ev.preventDefault();
    this.api.transport.reply(ev.detail, {});
    this.finish('ended');
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
    for (const action of WIDGET_CLOSE_ACTIONS) {
      api.on(`action:${action}`, this.onClose);
    }
    api.on('error:preparing', this.onPreparingError);
  }

  hangUp(): void {
    if (this.finished) return;
    this.api.transport
      .send(HANGUP_ACTION, {})
      .catch(ignore)
      .finally(() => this.finish('ended'));
  }

  private finish(state: 'ended' | 'failed'): void {
    if (this.finished) return;
    this.finished = true;
    this.currentState.set(state);
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    this.api.removeListener(
      `action:${WidgetApiFromWidgetAction.ContentLoaded}`,
      this.onContentLoaded,
    );
    for (const action of WIDGET_CLOSE_ACTIONS) {
      this.api.removeListener(`action:${action}`, this.onClose);
    }
    this.api.removeListener('error:preparing', this.onPreparingError);
    this.api.stop();
    this.onEnded();
  }
}
