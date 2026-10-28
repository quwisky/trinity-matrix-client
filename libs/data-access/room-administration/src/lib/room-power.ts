import type {
  JsonObject,
  Membership,
  PowerLevel,
} from './room-administration-engine';

/** Actions whose threshold is a top-level `m.room.power_levels` key. */
export type PowerAction = 'invite' | 'kick' | 'ban' | 'redact';

// These port matrix-js-sdk 43 `RoomState` checks so the UI offers exactly what js-sdk did;
// the parity spec pins them. Who has what power stays the engine's (`PowerLevel`).

/** `'infinite'` as `Infinity`, for numeric comparisons. */
export function powerValue(power: PowerLevel): number {
  return power === 'infinite' ? Infinity : power;
}

/** `hasSufficientPowerLevelFor`: the key when it is a finite number, else 50, even without power levels. */
export function mayAct(
  powerLevels: JsonObject | null,
  power: PowerLevel,
  action: PowerAction,
): boolean {
  const level = powerLevels?.[action];
  return (
    powerValue(power) >=
    (typeof level === 'number' && Number.isFinite(level) ? level : 50)
  );
}

/** `maySendStateEvent`: without power levels anyone may; else `events[type]` or `state_default` (50). */
export function maySendState(
  powerLevels: JsonObject | null,
  power: PowerLevel,
  type: string,
): boolean {
  return powerValue(power) >= requiredToSend(powerLevels, type, true);
}

/** `maySendEvent`: `events[type]`, else `events_default` (0). */
export function maySendEvent(
  powerLevels: JsonObject | null,
  power: PowerLevel,
  type: string,
): boolean {
  return powerValue(power) >= requiredToSend(powerLevels, type, false);
}

/**
 * `maySendRedactionForEvent` for a sent, unredacted event: a member who has not left may
 * send redactions, then redacts their own events or needs the `redact` level.
 */
export function mayRedactEvent(
  powerLevels: JsonObject | null,
  power: PowerLevel,
  membership: Membership | null,
  ownEvent: boolean,
): boolean {
  if (membership === null || membership === 'leave') return false;
  if (!maySendEvent(powerLevels, power, 'm.room.redaction')) return false;
  return ownEvent || mayAct(powerLevels, power, 'redact');
}

function requiredToSend(
  powerLevels: JsonObject | null,
  type: string,
  state: boolean,
): number {
  if (!powerLevels) return 0;
  const events = powerLevels['events'];
  const level =
    typeof events === 'object' && events !== null && !Array.isArray(events)
      ? (events as JsonObject)[type]
      : undefined;
  if (Number.isSafeInteger(level)) return level as number;
  const fallback = powerLevels[state ? 'state_default' : 'events_default'];
  if (Number.isSafeInteger(fallback)) return fallback as number;
  return state ? 50 : 0;
}
