import { describe, expectTypeOf, it } from 'vitest';
import type { JoinedPackRoom } from '../expression-engine';
import type { JoinedPackRoomDto } from './JoinedPackRoomDto';

describe('Rust engine DTOs', () => {
  it('match what the TypeScript types describe, numbers included', () => {
    // Not `toEqualTypeOf` over `DeepWritable`, which turns `unknown` content into `{}`.
    expectTypeOf<JoinedPackRoomDto>().toExtend<JoinedPackRoom>();
    expectTypeOf<keyof JoinedPackRoomDto>().toEqualTypeOf<
      keyof JoinedPackRoom
    >();
    expectTypeOf<JoinedPackRoomDto['events'][number]>().toEqualTypeOf<{
      type: string;
      state_key: string;
      content: unknown;
    }>();
  });
});
