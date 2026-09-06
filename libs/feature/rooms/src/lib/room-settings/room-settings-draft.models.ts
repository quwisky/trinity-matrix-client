import {
  HistoryVisibility,
  JoinRule,
  type RoomSettingsPermissions,
} from '@trinity/data-access/room-administration';

export interface RoomSettingsModel {
  name: string;
  topic: string;
  joinRule: JoinRule;
  historyVisibility: HistoryVisibility;
}

export interface GeneralBaseline {
  readonly name: string;
  readonly topic: string;
}

export interface AccessBaseline {
  readonly joinRule: JoinRule;
  readonly historyVisibility: HistoryVisibility;
  readonly allowedSpaceIds: readonly string[];
}

export const DENIED_ROOM_SETTINGS: RoomSettingsPermissions = {
  name: { available: false, reason: 'Room settings are unavailable.' },
  topic: { available: false, reason: 'Room settings are unavailable.' },
  avatar: { available: false, reason: 'Room settings are unavailable.' },
  joinRule: { available: false, reason: 'Room settings are unavailable.' },
  history: { available: false, reason: 'Room settings are unavailable.' },
  aliases: { available: false, reason: 'Room settings are unavailable.' },
};

export const JOIN_RULE_OPTIONS = [
  { value: JoinRule.Invite, label: 'Invite only' },
  { value: JoinRule.Public, label: 'Anyone can join' },
] as const;

export const ROOM_HISTORY_OPTIONS = [
  {
    value: HistoryVisibility.Shared,
    label: 'Members — all history',
    testId: 'history-shared',
  },
  {
    value: HistoryVisibility.Invited,
    label: 'Members — since they were invited',
    testId: 'history-invited',
  },
  {
    value: HistoryVisibility.Joined,
    label: 'Members — since they joined',
    testId: 'history-joined',
  },
  {
    value: HistoryVisibility.WorldReadable,
    label: 'Anyone, even without joining',
    testId: 'history-world_readable',
  },
] as const;

export function sameMembers(
  a: readonly string[],
  b: readonly string[],
): boolean {
  const set = new Set(b);
  return a.length === set.size && a.every((id) => set.has(id));
}

const OTHER_RULE_LABELS: Partial<Record<JoinRule, string>> = {
  [JoinRule.Restricted]: 'Space members',
  [JoinRule.Knock]: 'Anyone can ask to join',
};

export function withCurrentRule(
  options: { value: JoinRule; label: string }[],
  current: JoinRule,
): { value: JoinRule; label: string }[] {
  return options.some((option) => option.value === current)
    ? options
    : [
        ...options,
        { value: current, label: OTHER_RULE_LABELS[current] ?? current },
      ];
}

export function sentenceList(fields: readonly string[]): string {
  if (fields.length === 0) return 'Room details';
  const sentence = new Intl.ListFormat('en', { type: 'conjunction' }).format(
    fields,
  );
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
