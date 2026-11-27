export const RING_EVENT_TYPES: readonly string[] = [
  'org.matrix.msc4075.rtc.notification',
  'm.rtc.notification',
];

/** Whether a call event asks for video (true), audio (false) or says nothing (null). */
export function ringVideo(content: unknown): boolean | null {
  const intent =
    typeof content === 'object' && content !== null
      ? (content as Record<string, unknown>)['m.call.intent']
      : undefined;
  return intent === 'video' ? true : intent === 'audio' ? false : null;
}
