import { signal } from '@angular/core';
import {
  ClientWidgetApi,
  OpenIDRequestState,
  Widget,
  WidgetDriver,
  type Capability,
  type IOpenIDUpdate,
  type SimpleObservable,
} from 'matrix-widget-api';
import type {
  WidgetBridgeSession,
  WidgetBridgeState,
} from './widget-bridge.service';
import type { RoomWidget } from './widget.model';

/*
 * The only module in the application that imports matrix-widget-api. `WidgetBridgeService`
 * loads it with a dynamic `import()`, so the Widget API stays out of the initial bundle and
 * is fetched the first time a room widget opens.
 */

/** Tier 2a deliberately grants no Matrix, OpenID, navigation, media, or TURN access. */
export class RestrictedWidgetDriver extends WidgetDriver {
  override validateCapabilities(
    _requested: Set<Capability>,
  ): Promise<Set<Capability>> {
    return Promise.resolve(new Set());
  }

  override askOpenID(observer: SimpleObservable<IOpenIDUpdate>): void {
    observer.update({ state: OpenIDRequestState.Blocked });
  }
}

/** Bind a restricted client Widget API to a frame whose `src` is not yet set. */
export function startWidgetBridge(
  widget: RoomWidget,
  url: string,
  roomId: string,
  iframe: HTMLIFrameElement,
  onStop: (session: WidgetBridgeSession) => void,
): WidgetBridgeSession {
  const protocolWidget = new Widget({
    id: widget.id,
    creatorUserId: widget.creatorUserId!,
    type: widget.type,
    name: widget.name,
    url,
    waitForIframeLoad: widget.waitForIframeLoad,
    data: widget.data,
  });
  const api = new ClientWidgetApi(
    protocolWidget,
    iframe,
    new RestrictedWidgetDriver(),
  );
  api.setViewedRoomId(roomId);
  return new ActiveWidgetBridge(api, iframe, onStop);
}

class ActiveWidgetBridge implements WidgetBridgeSession {
  private readonly currentState = signal<WidgetBridgeState>('frame-loading');
  private stopped = false;
  private readonly handshakeTimer: ReturnType<typeof setTimeout>;

  readonly state = this.currentState.asReadonly();

  private readonly onPreparing = (): void => {
    if (this.stopped) return;
    this.currentState.set('negotiating');
  };
  private readonly onReady = (): void => {
    if (this.stopped) return;
    clearTimeout(this.handshakeTimer);
    this.currentState.set('ready');
  };
  private readonly onError = (): void => {
    if (this.stopped) return;
    clearTimeout(this.handshakeTimer);
    this.currentState.set('failed');
  };

  constructor(
    private readonly api: ClientWidgetApi,
    private readonly iframe: HTMLIFrameElement,
    private readonly onStop: (session: WidgetBridgeSession) => void,
  ) {
    this.api.on('preparing', this.onPreparing);
    this.api.on('ready', this.onReady);
    this.api.on('error:preparing', this.onError);
    this.handshakeTimer = setTimeout(() => this.onError(), 12_000);
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    clearTimeout(this.handshakeTimer);
    this.api.removeListener('preparing', this.onPreparing);
    this.api.removeListener('ready', this.onReady);
    this.api.removeListener('error:preparing', this.onError);
    this.api.stop();
    this.iframe.removeAttribute('src');
    this.iframe.remove();
    this.onStop(this);
  }
}
