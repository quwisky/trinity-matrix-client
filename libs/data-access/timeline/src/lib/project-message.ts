import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk';
import { safeBuildLegacyMessageView } from '@trinity/util/matrix';
import { normalizeTimelineEvent } from './normalize-timeline-event';
import {
  presentNormalizedTimelineEvent,
  type MessageMediaPayload,
  type MessagePollView,
  type MessageShield,
  type MessageView,
} from './message-presentation';

function freezeMedia(media: MessageView['media']): MessageMediaPayload | null {
  if (!media) return null;
  const freezeFile = (file: typeof media.file) =>
    file
      ? Object.freeze({
          ...file,
          key: Object.freeze({
            ...file.key,
            ...(file.key.key_ops
              ? { key_ops: Object.freeze([...file.key.key_ops]) }
              : {}),
          }),
          hashes: Object.freeze({ ...file.hashes }),
        })
      : null;
  return Object.freeze({
    ...media,
    file: freezeFile(media.file),
    thumbnailFile: freezeFile(media.thumbnailFile),
    ...(media.waveform ? { waveform: Object.freeze([...media.waveform]) } : {}),
  });
}

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
 * normalization and Message Presentation boundary; media/polls remain on the explicitly
 * temporary legacy branch owned by #307-#309.
 */
export function projectMessage(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
  shield: MessageShield | null = null,
): MessageView | null {
  const normalized = normalizeTimelineEvent(client, room, event, shield);
  if (normalized) {
    return presentNormalizedTimelineEvent(normalized);
  }

  // The remaining view kinds are media, location, sticker, and poll. Freeze their current
  // model at the capability boundary until their owning migration replaces this adapter.
  const legacy = safeBuildLegacyMessageView(client, room, event, shield);
  return Object.freeze({
    ...legacy,
    media: freezeMedia(legacy.media),
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
