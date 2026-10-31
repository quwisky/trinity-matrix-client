import { describe, expectTypeOf, it } from 'vitest';
import type {
  RoomWidgetSnapshot,
  RoomWidgetStateContent,
  WidgetIdentity,
} from '../room-widget-engine';
import type { RoomWidget } from '../widget.model';
import type { RoomWidgetDto } from './RoomWidgetDto';
import type { RoomWidgetSnapshotDto } from './RoomWidgetSnapshotDto';
import type { RoomWidgetStateContentDto } from './RoomWidgetStateContentDto';
import type { WidgetIdentityDto } from './WidgetIdentityDto';

describe('Rust engine DTOs', () => {
  it('match what the TypeScript types describe', () => {
    expectTypeOf<RoomWidgetDto>().toExtend<RoomWidget>();
    expectTypeOf<keyof RoomWidgetDto>().toEqualTypeOf<keyof RoomWidget>();
    expectTypeOf<WidgetIdentityDto>().toExtend<WidgetIdentity>();
    expectTypeOf<keyof WidgetIdentityDto>().toEqualTypeOf<
      keyof WidgetIdentity
    >();
    expectTypeOf<RoomWidgetSnapshotDto>().toExtend<RoomWidgetSnapshot>();
    expectTypeOf<keyof RoomWidgetSnapshotDto>().toEqualTypeOf<
      keyof RoomWidgetSnapshot
    >();
    expectTypeOf<
      RoomWidgetSnapshotDto['identity']
    >().toEqualTypeOf<WidgetIdentityDto | null>();
    expectTypeOf<RoomWidgetStateContent>().toExtend<RoomWidgetStateContentDto>();
    expectTypeOf<keyof RoomWidgetStateContentDto>().toEqualTypeOf<
      keyof RoomWidgetStateContent
    >();
  });
});
