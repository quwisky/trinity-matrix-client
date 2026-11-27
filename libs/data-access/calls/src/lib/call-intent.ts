import { callParticipants } from '@trinity/util/matrix';
import type { RawCallEvent } from './call-transport';

export { callParticipants };

export type ElementCallIntent =
  | 'start_call'
  | 'join_existing'
  | 'start_call_voice'
  | 'join_existing_voice'
  | 'start_call_dm'
  | 'join_existing_dm'
  | 'start_call_dm_voice'
  | 'join_existing_dm_voice';

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
  return callParticipants(memberEvents, nowMs).count > 0;
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

/** `m:ss` under an hour, `h:mm:ss` from one hour on. */
export function formatCallElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}
