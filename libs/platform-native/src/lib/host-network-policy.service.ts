import { Injectable } from '@angular/core';
import { getTrinityDesktopBridge } from './trinity-desktop-bridge';

/** Desktop transport-policy seam; callers publish origins without host detection. */
@Injectable({ providedIn: 'root' })
export class HostNetworkPolicyService {
  allowOrigin(origin: string): void {
    getTrinityDesktopBridge()?.capabilities.networkCors.allowOrigin(origin);
  }

  replaceAllowedOrigins(origins: readonly string[]): void {
    getTrinityDesktopBridge()?.capabilities.networkCors.setAllowedOrigins(
      origins,
    );
  }
}
