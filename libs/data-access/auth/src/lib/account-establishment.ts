import {
  AuthenticatedAccountGrant,
  type AccountEstablishmentIntent,
} from '@trinity/data-access/accounts';
import type { MatrixSession, OidcSessionBinding } from '@trinity/util/matrix';

export type LoginMode = 'replace' | 'add';

export interface AuthenticatedSessionResponse {
  user_id: string;
  device_id: string;
  access_token: string;
  refresh_token?: string;
  accessTokenExpiresAt?: number;
  oidc?: OidcSessionBinding;
}

export function accountEstablishment(
  baseUrl: string,
  response: AuthenticatedSessionResponse,
  mode: LoginMode,
  accountRecord: AccountEstablishmentIntent['accountRecord'],
): {
  readonly grant: AuthenticatedAccountGrant;
  readonly intent: AccountEstablishmentIntent;
} {
  const session: MatrixSession = {
    baseUrl,
    userId: response.user_id,
    deviceId: response.device_id,
    accessToken: response.access_token,
    ...(response.refresh_token !== undefined
      ? { refreshToken: response.refresh_token }
      : {}),
    ...(response.accessTokenExpiresAt !== undefined
      ? { accessTokenExpiresAt: response.accessTokenExpiresAt }
      : {}),
    ...(response.oidc ? { oidc: response.oidc } : {}),
  };
  return {
    grant: AuthenticatedAccountGrant.issue(session),
    intent: {
      placement: 'active',
      liveAccounts: mode === 'add' ? 'keep' : 'replace',
      accountRecord,
    },
  };
}
