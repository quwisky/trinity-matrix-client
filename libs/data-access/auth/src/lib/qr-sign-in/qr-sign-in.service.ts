import { Injectable, inject } from '@angular/core';
import type { MatrixClient } from 'matrix-js-sdk';
import type { Observable } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { QrSignInAdapter, type ExistingDeviceLink } from './qr-sign-in.adapter';
import type { NewDeviceState } from './qr-sign-in.model';

/** Links devices as the one account it was created for. */
export interface QrDeviceLinker {
  readonly accountId: string;
  /** Links the device whose code this device scanned; `state$` is cold. */
  link(qrBytes: Uint8Array): ExistingDeviceLink;
}

/** Sign-in by QR code (MSC4108): a new device shows the code, an existing device scans it. */
@Injectable({ providedIn: 'root' })
export class QrSignInService {
  private readonly adapter = inject(QrSignInAdapter);
  private readonly matrix = inject(MatrixClientService);

  /**
   * Cold: each subscription shows a new code; unsubscribing cancels the sign-in. The other
   * device must be signed in on `serverName`, the server entered.
   */
  signInByShowingCode(
    homeserverUrl: string,
    serverName: string,
  ): Observable<NewDeviceState> {
    return this.adapter.signInByShowingCode(homeserverUrl, serverName);
  }

  /** Links the device whose code this device scanned; `state$` is cold. */
  linkByScanning(
    client: MatrixClient,
    qrBytes: Uint8Array,
  ): ExistingDeviceLink {
    return this.adapter.linkByScanning(client, qrBytes);
  }

  /**
   * Captures the active account's client now, so a link started from it never runs as an
   * account switched to later. Null when no account is live.
   */
  linkerForActiveAccount(): QrDeviceLinker | null {
    const accountId = this.matrix.activeUserId();
    const client = accountId ? this.matrix.clientFor(accountId) : null;
    if (!accountId || !client) return null;
    return {
      accountId,
      link: (qrBytes) => this.adapter.linkByScanning(client, qrBytes),
    };
  }
}
