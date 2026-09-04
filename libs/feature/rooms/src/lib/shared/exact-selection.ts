/** Exact Account-owned Room identity carried from a rendered row into a command. */
export interface ExactRoomSelection {
  readonly roomId: string;
  readonly accountId: string;
}

/** Exact Account-owned Space identity carried from a rendered row into a command. */
export interface ExactSpaceSelection {
  readonly spaceId: string | null;
  readonly accountId: string;
}
