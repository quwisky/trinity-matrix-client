import { Injectable } from '@angular/core';
import { OAuthGrantType, createClient } from 'matrix-js-sdk';
import { lacksAuthMetadata } from '../account-server-api';

// The message of the SDK's OAuth2Error.OpSupport, thrown for metadata that fails validation.
const INVALID_AUTH_METADATA =
  'Configured OAuth2 OP does not support required functions';

/** The seam to the SDK's QR sign-in (MSC4108) support. */
@Injectable({ providedIn: 'root' })
export class QrSignInAdapter {
  /**
   * Same checks as the SDK's isSignInWithQRAvailable, except that an unreachable server
   * rejects instead of resolving false, so "unreachable" differs from "not supported". A server
   * with no usable auth metadata (404, M_UNRECOGNIZED, invalid metadata) is "not supported".
   */
  async isAvailable(homeserverUrl: string): Promise<boolean> {
    const client = createClient({ baseUrl: homeserverUrl });
    try {
      const metadata = await client
        .getAuthMetadata()
        .catch((error: unknown) => {
          if (
            lacksAuthMetadata(error) ||
            (error instanceof Error && error.message === INVALID_AUTH_METADATA)
          ) {
            return null;
          }
          throw error;
        });
      if (!metadata) return false;
      if (
        !metadata.grant_types_supported.includes(
          OAuthGrantType.DeviceAuthorization,
        )
      ) {
        return false;
      }
      return await client.doesServerSupportUnstableFeature(
        'org.matrix.msc4108',
      );
    } finally {
      client.stopClient();
    }
  }
}
