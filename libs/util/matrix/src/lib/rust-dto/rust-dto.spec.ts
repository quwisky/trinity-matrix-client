import { describe, expectTypeOf, it } from 'vitest';

import type { DeepWritable } from '../deep-writable';
import type { EngineFailure } from '../engine-result';
import type { MatrixRequestFailureMetadata } from '../request-failure';
import type { Diagnostic } from './Diagnostic';
import type { DiscoveryParams } from './DiscoveryParams';
import type { EngineFailure as EngineFailureDto } from './EngineFailure';
import type { RequestParams } from './RequestParams';
import type { UiaChallengeDto } from './UiaChallengeDto';
import type { UiaChallenge } from '../uia-flow';

type Params<C extends EngineFailure['code']> = NonNullable<
  Extract<EngineFailure, { code: C }> extends { params?: infer P } ? P : never
>;

describe('Rust engine DTOs', () => {
  it('produce only engine failures the TypeScript type allows', () => {
    // One direction only: the Rust engine implements a subset of the codes.
    expectTypeOf<EngineFailureDto>().toExtend<DeepWritable<EngineFailure>>();
  });

  it('name only optional fields the TypeScript type has', () => {
    // Assignability lets an optional field go missing, so a renamed one needs its own check.
    expectTypeOf<keyof Diagnostic>().toExtend<
      keyof MatrixRequestFailureMetadata
    >();
    expectTypeOf<keyof DiscoveryParams>().toExtend<
      keyof Params<'discovery-failed'>
    >();
    expectTypeOf<keyof RequestParams>().toExtend<
      keyof Params<'request-failed'>
    >();
    expectTypeOf<keyof UiaChallengeDto>().toExtend<keyof UiaChallenge>();
  });
});
