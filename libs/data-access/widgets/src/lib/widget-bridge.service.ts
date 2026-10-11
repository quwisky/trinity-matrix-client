import { Injectable, type Signal } from '@angular/core';
import { defer, from, map, type Observable } from 'rxjs';
import type { RoomWidget, WidgetEmbed } from './widget.model';

export type WidgetBridgeState =
  'frame-loading' | 'negotiating' | 'ready' | 'failed';

export interface WidgetBridgeSession {
  readonly state: Signal<WidgetBridgeState>;
  stop(): void;
}

@Injectable({ providedIn: 'root' })
export class WidgetBridgeService {
  private active: WidgetBridgeSession | null = null;

  /**
   * Bind the restricted Widget API to `iframe` before the caller assigns its `src`.
   *
   * Cold and finite: subscribing validates the embed, fetches the Widget API chunk on first
   * use, then emits one live session and completes. Unsubscribing before the chunk arrives
   * binds nothing. The caller owns the emitted session and stops it.
   */
  start(
    widget: RoomWidget,
    embed: WidgetEmbed,
    roomId: string,
    iframe: HTMLIFrameElement,
  ): Observable<WidgetBridgeSession> {
    return defer(() => {
      const url = validatedEmbedUrl(widget, embed);
      return from(import('./widget-bridge-runtime')).pipe(
        map(({ startWidgetBridge }) => {
          this.active?.stop();
          const session = startWidgetBridge(
            widget,
            url,
            roomId,
            iframe,
            (stopped) => {
              if (this.active === stopped) {
                this.active = null;
              }
            },
          );
          this.active = session;
          return session;
        }),
      );
    });
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
