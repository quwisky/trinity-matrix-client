import type { RawCallEvent } from './call-transport';

export type ElementCallIntent =
  | 'start_call'
  | 'join_existing'
  | 'start_call_voice'
  | 'join_existing_voice'
  | 'start_call_dm'
  | 'join_existing_dm'
  | 'start_call_dm_voice'
  | 'join_existing_dm_voice';

const CALL_MEMBER_TYPE = 'org.matrix.msc3401.call.member';

export function callIntent(o: {
  dm: boolean;
  ongoing: boolean;
  video: boolean;
}): ElementCallIntent {
  return `${o.ongoing ? 'join_existing' : 'start_call'}${o.dm ? '_dm' : ''}${
    o.video ? '' : '_voice'
  }` as ElementCallIntent;
}

export function hasOngoingCall(
  memberEvents: readonly RawCallEvent[],
  nowMs: number,
): boolean {
  return memberEvents.some((event) => {
    if (event.type !== CALL_MEMBER_TYPE) return false;
    const { content } = event;
    if (Object.keys(content).length === 0) return false;
    const expiresTs =
      typeof content['expires_ts'] === 'number'
        ? content['expires_ts']
        : typeof content['expires'] === 'number'
          ? event.origin_server_ts + content['expires']
          : undefined;
    return expiresTs === undefined || expiresTs >= nowMs;
  });
}

export function callWidgetUrl(o: {
  appOrigin: string;
  widgetId: string;
  roomId: string;
  userId: string;
  deviceId: string;
  homeserverUrl: string;
  intent: ElementCallIntent;
  theme: 'light' | 'dark';
}): string {
  const params = new URLSearchParams({
    widgetId: o.widgetId,
    parentUrl: o.appOrigin,
    baseUrl: o.homeserverUrl,
    roomId: o.roomId,
    userId: o.userId,
    deviceId: o.deviceId,
    intent: o.intent,
    theme: o.theme,
    confineToRoom: 'true',
    lang: 'en',
    enableE2EE: 'true',
  });
  return `${o.appOrigin}/element-call/index.html?${params}`;
}
