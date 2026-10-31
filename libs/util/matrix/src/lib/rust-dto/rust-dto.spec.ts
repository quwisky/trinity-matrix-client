import { describe, expectTypeOf, it } from 'vitest';

import type { DeepWritable } from '../deep-writable';
import type { EngineFailure } from '../engine-result';
import type { MatrixRequestFailureMetadata } from '../request-failure';
import type { Diagnostic } from './Diagnostic';
import type { DiscoveryParams } from './DiscoveryParams';
import type { EngineFailure as EngineFailureDto } from './EngineFailure';
import type { RequestParams } from './RequestParams';
import type { UiaChallengeDto } from './UiaChallengeDto';
import type { VectorDiffDto } from './VectorDiffDto';
import type { UiaChallenge } from '../uia-flow';
import type { VectorDiff } from '../vector-diff';

type Params<C extends EngineFailure['code']> = NonNullable<
  Extract<EngineFailure, { code: C }> extends { params?: infer P } ? P : never
>;

describe('Rust engine DTOs', () => {
  it('produce only engine failures the TypeScript type allows', () => {
    // One direction only: the Rust engine implements a subset of the codes.
    expectTypeOf<EngineFailureDto>().toExtend<DeepWritable<EngineFailure>>();
  });

  it('produce only list updates the TypeScript type allows', () => {
    // One direction only: all eleven ops, so the codes match exactly.
    expectTypeOf<VectorDiffDto<{ n: number }>>().toExtend<
      VectorDiff<{ n: number }>
    >();
    expectTypeOf<VectorDiffDto<{ n: number }>['op']>().toEqualTypeOf<
      VectorDiff<{ n: number }>['op']
    >();
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
