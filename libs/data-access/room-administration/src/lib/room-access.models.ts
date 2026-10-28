/** SDK-free access constants; values mirror matrix-js-sdk's enums of the same names. */
export const JoinRule = {
  Public: 'public',
  Invite: 'invite',
  Private: 'private',
  Knock: 'knock',
  Restricted: 'restricted',
} as const;
export type JoinRule = (typeof JoinRule)[keyof typeof JoinRule];

export const HistoryVisibility = {
  Invited: 'invited',
  Joined: 'joined',
  Shared: 'shared',
  WorldReadable: 'world_readable',
} as const;
export type HistoryVisibility =
  (typeof HistoryVisibility)[keyof typeof HistoryVisibility];

export const RestrictedAllowType = {
  RoomMembership: 'm.room_membership',
} as const;
export type RestrictedAllowType =
  (typeof RestrictedAllowType)[keyof typeof RestrictedAllowType];
