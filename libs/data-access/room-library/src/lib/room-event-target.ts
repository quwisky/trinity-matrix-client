/**
 * The room a client-level room event concerns.
 *
 * matrix-js-sdk re-emits room events at the client with the room among their arguments, or
 * an event that names it (`getRoomId()`). Shared by the projections that rebuild only the
 * rooms an event touched (#1292, #1311).
 */
export function roomIdOf(args: readonly unknown[]): string | undefined {
  for (const arg of args) {
    if (arg && typeof arg === 'object') {
      const candidate = arg as {
        roomId?: unknown;
        getRoomId?: () => string | undefined;
      };
      if (typeof candidate.roomId === 'string') return candidate.roomId;
      const fromEvent = candidate.getRoomId?.();
      if (typeof fromEvent === 'string') return fromEvent;
    }
  }
  return undefined;
}

/**
 * How long the touched-room projections (#1292, #1311) trust their incremental updates. They
 * catch count changes by comparing counts on each sync; this bounds anything else the SDK
 * changes without an event they hear (a new thread's bundled latest reply, say). The next
 * refresh at least this long after the last full pass does a full one. Refreshes follow
 * syncs, so on an idle account the real bound is about the long-poll interval (~30 s).
 */
export const FULL_REFRESH_MS = 15_000;
