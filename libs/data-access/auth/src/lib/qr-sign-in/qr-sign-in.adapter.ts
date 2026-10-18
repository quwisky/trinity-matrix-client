import { Injectable } from '@angular/core';
import { OAuthGrantType, createClient } from 'matrix-js-sdk';

/** The seam to the SDK's QR sign-in (MSC4108) support; the only file that imports `matrix-js-sdk/lib/rendezvous` once Task 3 lands. */
@Injectable({ providedIn: 'root' })
export class QrSignInAdapter {
  /**
   * Same checks as the SDK's isSignInWithQRAvailable, except that a failed auth-metadata
   * fetch rejects instead of resolving false, so "unreachable" differs from "not supported".
   */
  async isAvailable(homeserverUrl: string): Promise<boolean> {
    const client = createClient({ baseUrl: homeserverUrl });
    try {
      const metadata = await client.getAuthMetadata();
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
