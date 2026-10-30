import { describe, expectTypeOf, it } from 'vitest';
import type { DeepWritable } from '@trinity/util/matrix';
import type {
  PublicRoomsPage,
  PublicRoomsQuery,
  RoomLinkPreviewData,
  UserDirectoryPage,
} from '../discovery-engine';
import type { PublicRoomsPageDto } from './PublicRoomsPageDto';
import type { PublicRoomsQueryDto } from './PublicRoomsQueryDto';
import type { RoomLinkPreviewDataDto } from './RoomLinkPreviewDataDto';
import type { UserDirectoryPageDto } from './UserDirectoryPageDto';

describe('Rust engine DTOs', () => {
  it('match what the TypeScript types describe, numbers included', () => {
    expectTypeOf<PublicRoomsPageDto>().toEqualTypeOf<
      DeepWritable<PublicRoomsPage>
    >();
    expectTypeOf<UserDirectoryPageDto>().toEqualTypeOf<
      DeepWritable<UserDirectoryPage>
    >();
    expectTypeOf<RoomLinkPreviewDataDto>().toEqualTypeOf<
      DeepWritable<RoomLinkPreviewData>
    >();
  });

  it('accept every query a TypeScript caller sends, and no other field', () => {
    expectTypeOf<PublicRoomsQuery>().toExtend<PublicRoomsQueryDto>();
    expectTypeOf<keyof PublicRoomsQueryDto>().toEqualTypeOf<
      keyof PublicRoomsQuery
    >();
  });
});
