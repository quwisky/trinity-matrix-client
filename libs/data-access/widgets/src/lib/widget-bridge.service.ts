import { Injectable, signal, type Signal } from '@angular/core';
import {
  ClientWidgetApi,
  OpenIDRequestState,
  Widget,
  WidgetDriver,
  type Capability,
  type IOpenIDUpdate,
  type SimpleObservable,
} from 'matrix-widget-api';
import type { RoomWidget, WidgetEmbed } from './widget.model';

export type WidgetBridgeState =
  'frame-loading' | 'negotiating' | 'ready' | 'failed';

export interface WidgetBridgeSession {
  readonly state: Signal<WidgetBridgeState>;
  stop(): void;
}

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

@Injectable({ providedIn: 'root' })
export class WidgetBridgeService {
  private active: ActiveWidgetBridge | null = null;

  start(
    widget: RoomWidget,
    embed: WidgetEmbed,
    roomId: string,
    iframe: HTMLIFrameElement,
  ): WidgetBridgeSession {
    const url = validatedEmbedUrl(widget, embed);
    this.active?.stop();

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
    const session = new ActiveWidgetBridge(api, iframe, () => {
      if (this.active === session) {
        this.active = null;
      }
    });
    this.active = session;
    return session;
  }
}

class ActiveWidgetBridge implements WidgetBridgeSession {
  private readonly currentState = signal<WidgetBridgeState>('frame-loading');
  private stopped = false;
  private readonly handshakeTimer: ReturnType<typeof setTimeout>;

  readonly state = this.currentState.asReadonly();

  private readonly onPreparing = (): void => {
    this.currentState.set('negotiating');
  };
  private readonly onReady = (): void => {
    clearTimeout(this.handshakeTimer);
    this.currentState.set('ready');
  };
  private readonly onError = (): void => {
    clearTimeout(this.handshakeTimer);
    this.currentState.set('failed');
  };

  constructor(
    private readonly api: ClientWidgetApi,
    private readonly iframe: HTMLIFrameElement,
    private readonly onStop: () => void,
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
    this.onStop();
  }
}

function validatedEmbedUrl(widget: RoomWidget, embed: WidgetEmbed): string {
  if (!widget.creatorUserId || !embed.url || !embed.origin) {
    throw new Error('Widget is not eligible for embedding');
  }
  const parsed = new URL(embed.url);
  if (parsed.protocol !== 'https:' || parsed.origin !== embed.origin) {
    throw new Error('Widget embed destination changed');
  }
  return parsed.href;
}
