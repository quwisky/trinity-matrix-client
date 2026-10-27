import { InjectionToken, inject } from '@angular/core';
import type { MatrixClient } from 'matrix-js-sdk';
import { MatrixClientService } from '../matrix-client.service';

export interface JsSdkClients {
  clientFor(accountId: string): MatrixClient | null;
}

export const JS_SDK_CLIENTS = new InjectionToken<JsSdkClients>(
  'JS_SDK_CLIENTS',
  {
    providedIn: 'root',
    factory: () => inject(MatrixClientService),
  },
);
