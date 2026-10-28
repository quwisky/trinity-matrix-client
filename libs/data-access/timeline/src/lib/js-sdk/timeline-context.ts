import type { MatrixClient, Room } from 'matrix-js-sdk';

/**
 * The open room with the client to act on it through, which the Conversation's factory binds
 * so `TimelineActionsService` acts on the room the timeline shows.
 */
export interface TimelineContext {
  client: MatrixClient;
  room: Room;
}
