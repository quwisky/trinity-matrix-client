const CALL_MEMBER_TYPE = 'org.matrix.msc3401.call.member';

/** The fields of a state event that decide whether a call member is live. */
export interface CallMemberEvent {
  type: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
}

/** Live participants of a call, from its `call.member` state events, and the earliest expiry. */
export function callParticipants(
  memberEvents: readonly CallMemberEvent[],
  nowMs: number,
): { count: number; nextExpiryMs: number | null } {
  let count = 0;
  let nextExpiryMs: number | null = null;
  for (const event of memberEvents) {
    if (event.type !== CALL_MEMBER_TYPE) continue;
    const content: unknown = event.content;
    if (typeof content !== 'object' || content === null) continue;
    const fields = content as Record<string, unknown>;
    if (Object.keys(fields).length === 0) continue;
    const memberships = fields['memberships'];
    if (Array.isArray(memberships)) {
      count += memberships.length;
      continue;
    }
    const expiresTs =
      typeof fields['expires_ts'] === 'number'
        ? fields['expires_ts']
        : typeof fields['expires'] === 'number'
          ? event.origin_server_ts + fields['expires']
          : undefined;
    if (expiresTs !== undefined && expiresTs < nowMs) continue;
    count++;
    if (expiresTs !== undefined) {
      nextExpiryMs =
        nextExpiryMs === null ? expiresTs : Math.min(nextExpiryMs, expiresTs);
    }
  }
  return { count, nextExpiryMs };
}
