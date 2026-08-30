import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk';
import { type MediaPipeline } from '@trinity/data-access/media';
import { normalizeTimelineEvent } from './normalize-timeline-event';
import {
  presentNormalizedTimelineEvent,
  type MessageShield,
  type MessageView,
} from './message-presentation';

/**
 * Production entrypoint for one timeline event. Federated input crosses the normalizer
 * before Message Presentation and media source material is replaced by an opaque reference.
 */
export function projectMessage(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
  shield: MessageShield | null,
  presentMedia: Pick<MediaPipeline, 'present'>,
): MessageView | null {
  const normalized = normalizeTimelineEvent(client, room, event, shield);
  return normalized
    ? presentNormalizedTimelineEvent(normalized, (media) =>
        presentMedia.present(media, client),
      )
    : null;
}
