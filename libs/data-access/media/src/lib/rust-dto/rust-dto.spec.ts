import { describe, expectTypeOf, it } from 'vitest';
import type { JoinedPackRoom, PackRoomSnapshot } from '../expression-engine';
import type { JoinedPackRoomDto } from './JoinedPackRoomDto';
import type { PackRoomDto } from './PackRoomDto';

describe('Rust engine DTOs', () => {
  it('match what the TypeScript types describe, numbers included', () => {
    // Not `toEqualTypeOf` over `DeepWritable`, which turns `unknown` content into `{}`.
    expectTypeOf<JoinedPackRoomDto>().toExtend<JoinedPackRoom>();
    expectTypeOf<keyof JoinedPackRoomDto>().toEqualTypeOf<
      keyof JoinedPackRoom
    >();
    expectTypeOf<JoinedPackRoomDto['roomName']>().toEqualTypeOf<
      string | null
    >();
    expectTypeOf<JoinedPackRoomDto['events'][number]>().toEqualTypeOf<{
      type: string;
      state_key: string;
      content: unknown;
    }>();
    expectTypeOf<PackRoomDto>().toExtend<PackRoomSnapshot>();
    expectTypeOf<keyof PackRoomDto>().toEqualTypeOf<keyof PackRoomSnapshot>();
    expectTypeOf<PackRoomDto['name']>().toEqualTypeOf<string | null>();
  });
});
