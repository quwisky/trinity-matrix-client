import { describe, expectTypeOf, it } from 'vitest';
import type { DeepWritable } from '@trinity/util/matrix';
import type { HomeserverProbe } from '../homeserver-engine';
import type { HomeserverProbeDto } from './HomeserverProbeDto';

describe('Rust engine DTOs', () => {
  it('match the probe the TypeScript type describes, numbers included', () => {
    expectTypeOf<HomeserverProbeDto>().toEqualTypeOf<
      DeepWritable<HomeserverProbe>
    >();
  });
});
