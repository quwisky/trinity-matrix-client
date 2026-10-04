import { Direction, type MatrixClient, type Room } from 'matrix-js-sdk';

/**
 * Page older history into the room's live timeline: `client.scrollback` without its race.
 *
 * `scrollback` reads the live timeline's back token when it sends, but inserts the page
 * into whichever timeline is live when the response lands (and hands that timeline the
 * page's next token). A gappy (`limited`) sync in between replaces the live timeline, so
 * the old timeline's history is spliced in front of the new one: the messages in the gap
 * never appear, and the new timeline's back token now skips them for good.
 *
 * This keeps scrollback's processing but pins the request to one timeline, and drops a page
 * that lands after that timeline stopped being live. The new live timeline then pages from
 * its own token on the next request.
 */
export async function scrollbackLive(
  client: MatrixClient,
  room: Room,
  limit: number,
): Promise<void> {
  const timeline = room.getLiveTimeline();
  const token = timeline.getPaginationToken(Direction.Backward);
  if (token === null) {
    return; // already at the start of the room
  }
  const res = await client.createMessagesRequest(
    room.roomId,
    token,
    limit,
    Direction.Backward,
  );
  if (room.getLiveTimeline() !== timeline) {
    return;
  }
  const mapper = client.getEventMapper();
  if (res.state) {
    timeline
      .getState(Direction.Forward)
      ?.setUnknownStateEvents(res.state.map(mapper));
  }
  const [timelineEvents, threadedEvents, unknownRelations] =
    room.partitionThreadedEvents(res.chunk.map(mapper));
  client.processAggregatedTimelineEvents(room, timelineEvents);
  room.addEventsToTimeline(timelineEvents, true, true, timeline);
  client.processThreadEvents(room, threadedEvents, true);
  for (const event of unknownRelations) {
    room.relations.aggregateChildEvent(event);
  }
  timeline.setPaginationToken(
    res.chunk.length === 0 ? null : (res.end ?? null),
    Direction.Backward,
  );
}
