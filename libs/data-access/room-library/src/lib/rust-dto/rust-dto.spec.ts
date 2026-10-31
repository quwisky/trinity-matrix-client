import { describe, expectTypeOf, it } from 'vitest';
import type { DeepWritable } from '@trinity/util/matrix';
import type {
  CreateRoomRequest,
  HierarchyEntry,
  InviteBlocking,
  RoomInfo,
  RoomListEngine,
  SpaceChildLink,
  TypingMember,
} from '../room-list-engine';
import type { CreateRoomRequestDto } from './CreateRoomRequestDto';
import type { DirectMapDto } from './DirectMapDto';
import type { HierarchyEntryDto } from './HierarchyEntryDto';
import type { HierarchyOptionsDto } from './HierarchyOptionsDto';
import type { InviteBlockingDto } from './InviteBlockingDto';
import type { ReceiptsDto } from './ReceiptsDto';
import type { RoomIdDto } from './RoomIdDto';
import type { RoomInfoDto } from './RoomInfoDto';
import type { RoomTagDto } from './RoomTagDto';
import type { SpaceChildLinkDto } from './SpaceChildLinkDto';
import type { SpaceChildLinkInputDto } from './SpaceChildLinkInputDto';
import type { TypingMapDto } from './TypingMapDto';
import type { TypingMemberDto } from './TypingMemberDto';

type SpaceChildLinkInput = NonNullable<
  Parameters<RoomListEngine['setSpaceChild']>[3]
>;
type HierarchyOptions = Parameters<RoomListEngine['spaceHierarchy']>[2];

describe('Rust engine DTOs', () => {
  it('match what the TypeScript types describe, numbers included', () => {
    expectTypeOf<RoomInfoDto>().toEqualTypeOf<DeepWritable<RoomInfo>>();
    expectTypeOf<TypingMemberDto>().toEqualTypeOf<DeepWritable<TypingMember>>();
    expectTypeOf<TypingMapDto>().toEqualTypeOf<
      DeepWritable<Readonly<Record<string, readonly TypingMember[]>>>
    >();
    expectTypeOf<DirectMapDto>().toEqualTypeOf<
      DeepWritable<Readonly<Record<string, readonly string[]>>>
    >();
    expectTypeOf<SpaceChildLinkDto>().toEqualTypeOf<
      DeepWritable<SpaceChildLink>
    >();
    expectTypeOf<HierarchyEntryDto>().toEqualTypeOf<
      DeepWritable<HierarchyEntry>
    >();
    expectTypeOf<InviteBlockingDto>().toEqualTypeOf<
      DeepWritable<InviteBlocking>
    >();
    expectTypeOf<RoomIdDto>().toEqualTypeOf<
      DeepWritable<{ readonly roomId: string }>
    >();
  });

  it('accept every input a TypeScript caller sends, and no other field', () => {
    expectTypeOf<CreateRoomRequest>().toExtend<CreateRoomRequestDto>();
    expectTypeOf<keyof CreateRoomRequestDto>().toEqualTypeOf<
      keyof CreateRoomRequest
    >();
    expectTypeOf<
      Parameters<RoomListEngine['setTag']>[2]
    >().toEqualTypeOf<RoomTagDto>();
    expectTypeOf<
      Parameters<RoomListEngine['markRead']>[2]
    >().toEqualTypeOf<ReceiptsDto>();
    // `readonly` does not survive JSON, so the caller's `readonly string[]` is compared without it.
    expectTypeOf<
      DeepWritable<SpaceChildLinkInput>
    >().toExtend<SpaceChildLinkInputDto>();
    expectTypeOf<keyof SpaceChildLinkInputDto>().toEqualTypeOf<
      keyof SpaceChildLinkInput
    >();
    expectTypeOf<HierarchyOptions>().toExtend<HierarchyOptionsDto>();
    expectTypeOf<keyof HierarchyOptionsDto>().toEqualTypeOf<
      keyof HierarchyOptions
    >();
  });
});
