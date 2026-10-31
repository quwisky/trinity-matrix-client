import { describe, expectTypeOf, it } from 'vitest';
import type {
  EncryptedFileInfo,
  MediaPayload,
  PollView,
} from '@trinity/util/matrix';
import type {
  EventTimelineItem,
  InReplyTo,
  Profile,
  ReactionGroup,
  SendState,
  ShieldCode,
  SystemChange,
  TimelineItem,
  TimelineItemContent,
  TimelineRoomState,
  TimelineUpdate,
} from '../timeline-engine';
import type { BackPagination } from './BackPagination';
import type { EncryptedFileInfoDto } from './EncryptedFileInfoDto';
import type { EventTimelineItemDto } from './EventTimelineItemDto';
import type { InReplyToDto } from './InReplyToDto';
import type { MediaPayloadDto } from './MediaPayloadDto';
import type { PollViewDto } from './PollViewDto';
import type { ProfileDto } from './ProfileDto';
import type { ReactionGroupDto } from './ReactionGroupDto';
import type { SendStateDto } from './SendStateDto';
import type { ShieldCodeDto } from './ShieldCodeDto';
import type { SystemChangeDto } from './SystemChangeDto';
import type { TimelineItemContentDto } from './TimelineItemContentDto';
import type { TimelineItemDto } from './TimelineItemDto';
import type { TimelineRoomStateDto } from './TimelineRoomStateDto';
import type { TimelineUpdateDto } from './TimelineUpdateDto';

/** `DeepWritable` that leaves `unknown` alone: that one turns it into `{}`. */
type Writable<T> = unknown extends T
  ? T
  : T extends (...args: never[]) => unknown
    ? T
    : { -readonly [K in keyof T]: Writable<T[K]> };

/** Assignable both ways: neither side may send or accept what the other does not describe. */
type Same<Dto, Written> = [Dto] extends [Writable<Written>]
  ? [Writable<Written>] extends [Dto]
    ? true
    : false
  : false;

type Items = Extract<TimelineUpdate, { kind: 'items' }>;

/** The shield reasons Rust produces: `unknown` stands for a reason the TypeScript side lacks. */
type KnownShield = Omit<ShieldCode, 'reason'> & {
  readonly reason: Exclude<ShieldCode['reason'], 'unknown'>;
};
type KnownEvent = Omit<EventTimelineItem, 'shield'> & {
  readonly shield: KnownShield | null;
};

describe('Rust timeline DTOs', () => {
  it('match what the TypeScript types describe, numbers included', () => {
    expectTypeOf<
      Same<EventTimelineItemDto & { kind: 'event' }, KnownEvent>
    >().toEqualTypeOf<true>();
    expectTypeOf<Same<ShieldCodeDto, KnownShield>>().toEqualTypeOf<true>();
    expectTypeOf<
      Same<TimelineItemContentDto, TimelineItemContent>
    >().toEqualTypeOf<true>();
    expectTypeOf<Same<SystemChangeDto, SystemChange>>().toEqualTypeOf<true>();
    expectTypeOf<Same<SendStateDto, SendState>>().toEqualTypeOf<true>();
    expectTypeOf<Same<ProfileDto, Profile>>().toEqualTypeOf<true>();
    expectTypeOf<Same<ReactionGroupDto, ReactionGroup>>().toEqualTypeOf<true>();
    expectTypeOf<Same<InReplyToDto, InReplyTo>>().toEqualTypeOf<true>();
    expectTypeOf<
      Same<TimelineRoomStateDto, TimelineRoomState>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Same<BackPagination, Items['backPagination']>
    >().toEqualTypeOf<true>();
  });

  it('produce only updates and items the TypeScript types allow', () => {
    // One direction only: the shield's `unknown` reason is never produced.
    expectTypeOf<TimelineItemDto>().toExtend<Writable<TimelineItem>>();
    expectTypeOf<TimelineUpdateDto>().toExtend<Writable<TimelineUpdate>>();
    expectTypeOf<ShieldCodeDto>().toExtend<Writable<ShieldCode>>();
  });

  it('match the shared types, which only this engine sends', () => {
    expectTypeOf<Same<MediaPayloadDto, MediaPayload>>().toEqualTypeOf<true>();
    expectTypeOf<
      Same<EncryptedFileInfoDto, EncryptedFileInfo>
    >().toEqualTypeOf<true>();
    expectTypeOf<Same<PollViewDto, PollView>>().toEqualTypeOf<true>();
  });

  it('name only optional fields the TypeScript type has', () => {
    // Assignability lets an optional field go missing, so a renamed one needs its own check.
    expectTypeOf<keyof MediaPayloadDto>().toEqualTypeOf<keyof MediaPayload>();
    expectTypeOf<keyof EncryptedFileInfoDto>().toEqualTypeOf<
      keyof EncryptedFileInfo
    >();
  });
});
