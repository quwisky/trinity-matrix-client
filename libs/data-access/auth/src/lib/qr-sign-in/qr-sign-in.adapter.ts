import { Injectable } from '@angular/core';
import { createClient } from 'matrix-js-sdk';
import { isSignInWithQRAvailable } from 'matrix-js-sdk/lib/rendezvous';

/** The only file that imports `matrix-js-sdk/lib/rendezvous`. */
@Injectable({ providedIn: 'root' })
export class QrSignInAdapter {
  isAvailable(homeserverUrl: string): Promise<boolean> {
    return isSignInWithQRAvailable(createClient({ baseUrl: homeserverUrl }));
  }
}
