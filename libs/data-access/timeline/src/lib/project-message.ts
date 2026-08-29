import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk';
import { safeBuildLegacyMessageView } from '@trinity/util/matrix';
import {
  type MediaPipeline,
  type PresentedMediaReference,
} from '@trinity/data-access/media';
import { normalizeTimelineEvent } from './normalize-timeline-event';
import {
  presentNormalizedTimelineEvent,
  type MessagePollView,
  type MessageShield,
  type MessageView,
} from './message-presentation';

function freezePoll(poll: MessageView['poll']): MessagePollView | null {
  return poll
    ? Object.freeze({
        ...poll,
        options: Object.freeze(
          poll.options.map((option) => Object.freeze({ ...option })),
        ),
      })
    : null;
}

/**
 * Production entrypoint for one timeline event. Text and system events cross the
 * normalizer directly; the remaining legacy event parser is immediately narrowed into
 * immutable presentation data, with media source material replaced by an opaque reference.
 */
export function projectMessage(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
  shield: MessageShield | null,
  presentMedia: Pick<MediaPipeline, 'present'>,
): MessageView | null {
  const normalized = normalizeTimelineEvent(client, room, event, shield);
  if (normalized) {
    return presentNormalizedTimelineEvent(normalized);
  }

  // The remaining view kinds are media, location, sticker, and poll. Freeze their current
  // model at the capability boundary until their owning migration replaces this adapter.
  const legacy = safeBuildLegacyMessageView(client, room, event, shield);
  const media: PresentedMediaReference | null = legacy.media
    ? presentMedia.present(legacy.media, client)
    : null;
  return Object.freeze({
    ...legacy,
    media,
    poll: freezePoll(legacy.poll),
    location: legacy.location ? Object.freeze({ ...legacy.location }) : null,
    reactions: Object.freeze(
      legacy.reactions.map((reaction) =>
        Object.freeze({
          ...reaction,
          reactors: Object.freeze([...reaction.reactors]),
        }),
      ),
    ),
    replyTo: legacy.replyTo ? Object.freeze({ ...legacy.replyTo }) : null,
    readReceipts: Object.freeze(
      legacy.readReceipts.map((receipt) => Object.freeze({ ...receipt })),
    ),
    shield: legacy.shield ? Object.freeze({ ...legacy.shield }) : null,
  });
}
