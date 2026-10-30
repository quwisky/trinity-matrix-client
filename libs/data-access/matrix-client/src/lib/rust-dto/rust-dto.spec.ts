import { describe, expectTypeOf, it } from 'vitest';
import type {
  DeepWritable,
  MatrixSession,
  OidcSessionBinding,
  UiaAuth,
} from '@trinity/util/matrix';
import type { AccountNameGroup } from '../known-names';
import type {
  AccountServerStatus,
  PendingTextMessage,
  PersistedAccountActivation,
  ServerLogoutHoldUpdate,
  SessionAccessToken,
  SessionAccountStatus,
  SessionCredentials,
  SessionEngine,
  SessionSnapshot,
  SessionSyncState,
} from '../session-engine';
import type { AccountNameGroupDto } from './AccountNameGroupDto';
import type { AccountServerStatusDto } from './AccountServerStatusDto';
import type { LiveAccountsDto } from './LiveAccountsDto';
import type { MatrixSessionDto } from './MatrixSessionDto';
import type { OidcBindingDto } from './OidcBindingDto';
import type { PendingTextMessageDto } from './PendingTextMessageDto';
import type { PersistedAccountActivationDto } from './PersistedAccountActivationDto';
import type { RefreshOptionsDto } from './RefreshOptionsDto';
import type { ServerLogoutHoldUpdateDto } from './ServerLogoutHoldUpdateDto';
import type { SessionAccessTokenDto } from './SessionAccessTokenDto';
import type { SessionAccountStatusDto } from './SessionAccountStatusDto';
import type { SessionCredentialsDto } from './SessionCredentialsDto';
import type { SessionSnapshotDto } from './SessionSnapshotDto';
import type { SessionSyncStateDto } from './SessionSyncStateDto';
import type { UiaAuthDto } from './UiaAuthDto';

type RefreshOptions = Parameters<SessionEngine['refreshAccessToken']>[1];

describe('Rust engine DTOs', () => {
  it('match what the TypeScript types describe, numbers included', () => {
    expectTypeOf<SessionSnapshotDto>().toEqualTypeOf<
      DeepWritable<SessionSnapshot>
    >();
    expectTypeOf<SessionAccountStatusDto>().toEqualTypeOf<
      DeepWritable<SessionAccountStatus>
    >();
    expectTypeOf<SessionSyncStateDto>().toEqualTypeOf<SessionSyncState>();
    expectTypeOf<SessionAccessTokenDto>().toEqualTypeOf<
      DeepWritable<SessionAccessToken>
    >();
    expectTypeOf<SessionCredentialsDto>().toEqualTypeOf<
      DeepWritable<SessionCredentials>
    >();
    expectTypeOf<ServerLogoutHoldUpdateDto>().toEqualTypeOf<
      DeepWritable<ServerLogoutHoldUpdate>
    >();
    expectTypeOf<PendingTextMessageDto>().toEqualTypeOf<
      DeepWritable<PendingTextMessage>
    >();
    expectTypeOf<AccountServerStatusDto>().toEqualTypeOf<AccountServerStatus>();
  });

  it('send name groups as arrays, which the lazy TypeScript iterable accepts', () => {
    expectTypeOf<AccountNameGroupDto>().toExtend<AccountNameGroup>();
    expectTypeOf<keyof AccountNameGroupDto>().toEqualTypeOf<
      keyof AccountNameGroup
    >();
  });

  it('accept every input a TypeScript caller sends', () => {
    expectTypeOf<MatrixSession>().toExtend<MatrixSessionDto>();
    expectTypeOf<UiaAuth>().toExtend<UiaAuthDto>();
    // Without it, a drifted password shape would still decode, as the session-only variant.
    expectTypeOf<Extract<UiaAuth, { password: string }>>().toExtend<
      Extract<UiaAuthDto, { password: string }>
    >();
    expectTypeOf<PersistedAccountActivation>().toEqualTypeOf<PersistedAccountActivationDto>();
    expectTypeOf<
      Parameters<SessionEngine['activateAccount']>[1]
    >().toEqualTypeOf<LiveAccountsDto>();
    expectTypeOf<RefreshOptions>().toExtend<RefreshOptionsDto>();
  });

  it('name only optional fields the TypeScript inputs have', () => {
    // Assignability lets an optional field go missing, so a renamed one needs its own check.
    expectTypeOf<keyof MatrixSessionDto>().toExtend<keyof MatrixSession>();
    expectTypeOf<keyof OidcBindingDto>().toExtend<keyof OidcSessionBinding>();
    expectTypeOf<keyof RefreshOptionsDto>().toEqualTypeOf<
      keyof RefreshOptions
    >();
  });
});
