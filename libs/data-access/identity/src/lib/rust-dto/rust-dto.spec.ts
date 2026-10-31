import { describe, expectTypeOf, it } from 'vitest';
import type { Observable } from 'rxjs';
import type {
  DeepWritable,
  EngineResult,
  PresenceState,
} from '@trinity/util/matrix';
import type {
  IdentityEngine,
  IgnoredUserInfo,
  PresenceInfo,
  UserProfile,
} from '../identity-engine';
import type { IgnoredUserInfoDto } from './IgnoredUserInfoDto';
import type { OwnPresenceDto } from './OwnPresenceDto';
import type { PresenceInfoDto } from './PresenceInfoDto';
import type { PresenceStateDto } from './PresenceStateDto';
import type { UserProfileDto } from './UserProfileDto';

type ResultValue<O> = O extends Observable<EngineResult<infer V>> ? V : never;

describe('Rust engine DTOs', () => {
  it('match what the TypeScript types describe, numbers included', () => {
    expectTypeOf<UserProfileDto>().toEqualTypeOf<DeepWritable<UserProfile>>();
    expectTypeOf<PresenceInfoDto>().toEqualTypeOf<DeepWritable<PresenceInfo>>();
    expectTypeOf<IgnoredUserInfoDto>().toEqualTypeOf<
      DeepWritable<IgnoredUserInfo>
    >();
    expectTypeOf<OwnPresenceDto>().toEqualTypeOf<
      DeepWritable<ResultValue<ReturnType<IdentityEngine['ownPresence']>>>
    >();
    expectTypeOf<PresenceStateDto>().toEqualTypeOf<PresenceState>();
  });

  it('accept every presence a TypeScript caller sets', () => {
    expectTypeOf<
      Parameters<IdentityEngine['setPresence']>[1]
    >().toExtend<PresenceStateDto>();
  });
});
