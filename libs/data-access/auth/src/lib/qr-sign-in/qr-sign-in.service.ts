import { Injectable, inject } from '@angular/core';
import type { MatrixClient } from 'matrix-js-sdk';
import type { Observable } from 'rxjs';
import { QrSignInAdapter, type ExistingDeviceLink } from './qr-sign-in.adapter';
import type { NewDeviceState } from './qr-sign-in.model';

/** Sign-in by QR code (MSC4108): a new device shows the code, an existing device scans it. */
@Injectable({ providedIn: 'root' })
export class QrSignInService {
  private readonly adapter = inject(QrSignInAdapter);

  /** Cold: each subscription shows a new code; unsubscribing cancels the sign-in. */
  signInByShowingCode(homeserverUrl: string): Observable<NewDeviceState> {
    return this.adapter.signInByShowingCode(homeserverUrl);
  }

  /** Links the device whose code this device scanned; `state$` is cold. */
  linkByScanning(
    client: MatrixClient,
    qrBytes: Uint8Array,
  ): ExistingDeviceLink {
    return this.adapter.linkByScanning(client, qrBytes);
  }
}
