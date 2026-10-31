import type { Observable } from 'rxjs';
import { describe, expectTypeOf, it } from 'vitest';
import type { DeepWritable, EngineResult } from '@trinity/util/matrix';
import type {
  ContactAddressesEngine,
  OpenIdToken,
} from '../contact-addresses-engine';
import type { AddEmailTokenRequestDto } from './AddEmailTokenRequestDto';
import type { AddThreePidRequestDto } from './AddThreePidRequestDto';
import type { BindThreePidRequestDto } from './BindThreePidRequestDto';
import type { DeleteThreePidDto } from './DeleteThreePidDto';
import type { EmailTokenDto } from './EmailTokenDto';
import type { IdentityServerSettingDto } from './IdentityServerSettingDto';
import type { OpenIdTokenDto } from './OpenIdTokenDto';
import type { ThreePidListDto } from './ThreePidListDto';
import type { UnbindStatusDto } from './UnbindStatusDto';
import type { UnbindThreePidRequestDto } from './UnbindThreePidRequestDto';

type ValueOf<T> =
  T extends Observable<EngineResult<infer Value>> ? DeepWritable<Value> : never;
type Request<Member extends (...args: never[]) => unknown> =
  Parameters<Member>[1];

describe('Rust engine DTOs', () => {
  it('match what the TypeScript types describe, numbers included', () => {
    expectTypeOf<ThreePidListDto>().toEqualTypeOf<
      ValueOf<ReturnType<ContactAddressesEngine['threePids']>>
    >();
    expectTypeOf<EmailTokenDto>().toEqualTypeOf<
      ValueOf<ReturnType<ContactAddressesEngine['requestAddEmailToken']>>
    >();
    expectTypeOf<OpenIdTokenDto>().toEqualTypeOf<DeepWritable<OpenIdToken>>();
    expectTypeOf<IdentityServerSettingDto>().toEqualTypeOf<
      ValueOf<ReturnType<ContactAddressesEngine['identityServerSetting']>>
    >();
    expectTypeOf<DeleteThreePidDto>().toEqualTypeOf<
      ValueOf<ReturnType<ContactAddressesEngine['deleteThreePid']>>
    >();
    expectTypeOf<UnbindStatusDto>().toEqualTypeOf<
      ValueOf<ReturnType<ContactAddressesEngine['unbindThreePid']>>
    >();
  });

  it('accept every request a TypeScript caller sends, and no other field', () => {
    expectTypeOf<
      Request<ContactAddressesEngine['requestAddEmailToken']>
    >().toExtend<AddEmailTokenRequestDto>();
    expectTypeOf<keyof AddEmailTokenRequestDto>().toEqualTypeOf<
      keyof Request<ContactAddressesEngine['requestAddEmailToken']>
    >();
    expectTypeOf<
      Request<ContactAddressesEngine['addThreePid']>
    >().toExtend<AddThreePidRequestDto>();
    expectTypeOf<keyof AddThreePidRequestDto>().toEqualTypeOf<
      keyof Request<ContactAddressesEngine['addThreePid']>
    >();
    expectTypeOf<
      Request<ContactAddressesEngine['bindThreePid']>
    >().toExtend<BindThreePidRequestDto>();
    expectTypeOf<keyof BindThreePidRequestDto>().toEqualTypeOf<
      keyof Request<ContactAddressesEngine['bindThreePid']>
    >();
    expectTypeOf<
      Request<ContactAddressesEngine['unbindThreePid']>
    >().toExtend<UnbindThreePidRequestDto>();
    expectTypeOf<keyof UnbindThreePidRequestDto>().toEqualTypeOf<
      keyof Request<ContactAddressesEngine['unbindThreePid']>
    >();
  });
});
