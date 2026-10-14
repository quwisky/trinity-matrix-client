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
