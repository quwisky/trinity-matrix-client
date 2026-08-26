import type { RoomWidget, WidgetEmbed, WidgetLaunch } from './widget.model';

const CALL_WIDGET_TYPES = new Set(['jitsi', 'm.jitsi', 'm.call']);

/** Call-adjacent widget types remain outside issue #51 on every management path. */
export function isCallWidgetType(type: string): boolean {
  return CALL_WIDGET_TYPES.has(type.trim().toLowerCase());
}

/** Revalidate an expanded destination at the iframe boundary. */
export function resolveWidgetEmbed(
  widget: RoomWidget,
  launch: WidgetLaunch,
  appOrigin: string,
): WidgetEmbed {
  if (!widget.creatorUserId) {
    return blocked('missing-creator');
  }
  if (isCallWidgetType(widget.type)) {
    return blocked('call-widget');
  }
  if (!launch.url || !launch.origin) {
    return blocked('invalid-url');
  }

  let parsed: URL;
  try {
    parsed = new URL(launch.url);
  } catch {
    return blocked('invalid-url');
  }
  if (parsed.protocol !== 'https:') {
    return blocked('insecure');
  }
  if (parsed.origin !== launch.origin) {
    return blocked('invalid-url');
  }
  if (parsed.origin === appOrigin) {
    return blocked('same-origin');
  }
  return { url: parsed.href, origin: parsed.origin, failure: null };
}

function blocked(failure: NonNullable<WidgetEmbed['failure']>): WidgetEmbed {
  return { url: null, origin: null, failure };
}
