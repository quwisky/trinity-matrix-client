import type { OidcProviderMetadata } from '@trinity/util/matrix';

/**
 * The fields Trinity reads from a homeserver's delegated-auth metadata
 * (`GET /_matrix/client/v1/auth_metadata`), required where the Matrix spec requires them.
 */
export interface AuthMetadata extends OidcProviderMetadata {
  readonly registration_endpoint: string;
  readonly account_management_uri?: string;
  readonly account_management_actions_supported?: readonly string[];
  readonly prompt_values_supported?: readonly string[];
  readonly grant_types_supported: readonly string[];
  /** RFC 9207: the provider says it always sends `iss` on its callback. */
  readonly authorization_response_iss_parameter_supported?: boolean;
}
