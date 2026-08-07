import type { ValidatedAuthMetadata } from 'matrix-js-sdk';

/**
 * A complete, realistic delegated-auth metadata document, shaped after what a
 * Matrix Authentication Service deployment serves at `/_matrix/client/v1/auth_metadata`.
 *
 * Deliberately COMPLETE rather than a `{ issuer } as unknown as …` stub. In production
 * this object only ever reaches us through `MatrixClient.getAuthMetadata()`, which runs
 * the SDK's own `isValidAuthMetadata` guard and THROWS on anything short of it — so a
 * partial fixture would let a spec pass against a config the app could never actually
 * receive. `oidc-client.service.spec.ts` pins that with an explicit
 * `isValidAuthMetadata(AUTH_METADATA)` assertion, which is what makes drift between this
 * fixture and the SDK's contract fail loudly on the next upgrade.
 *
 * Lives in its own module (not in a spec) so several specs can share it without
 * importing one spec file into another, which would re-register its suites.
 */
export const AUTH_METADATA = {
  issuer: 'https://op.example',
  authorization_endpoint: 'https://op.example/authorize',
  token_endpoint: 'https://op.example/oauth2/token',
  revocation_endpoint: 'https://op.example/oauth2/revoke',
  registration_endpoint: 'https://op.example/oauth2/registration',
  device_authorization_endpoint: 'https://op.example/oauth2/device',
  account_management_uri: 'https://op.example/account',
  account_management_actions_supported: [
    'org.matrix.profile',
    'org.matrix.sessions_list',
    'org.matrix.session_view',
    'org.matrix.session_end',
  ],
  response_types_supported: ['code'],
  response_modes_supported: ['form_post', 'query', 'fragment'],
  grant_types_supported: [
    'authorization_code',
    'refresh_token',
    'client_credentials',
    'urn:ietf:params:oauth:grant-type:device_code',
  ],
  code_challenge_methods_supported: ['S256'],
  prompt_values_supported: ['create'],
} satisfies ValidatedAuthMetadata;
