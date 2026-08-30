import { InjectionToken } from '@angular/core';
import { of, type Observable } from 'rxjs';

/** Provider metadata Trust needs to deep-link an externally managed recovery action. */
export interface TrustProviderManagement {
  readonly url: string;
  readonly actionsSupported: readonly string[];
}

/** App-composed Accounts integration; Trust never imports authentication lifecycle code. */
export interface TrustProviderRecoveryPort {
  accountManagement(): Observable<TrustProviderManagement | null>;
}

const NO_PROVIDER_RECOVERY: TrustProviderRecoveryPort = {
  accountManagement: () => of(null),
};

export const TRUST_PROVIDER_RECOVERY =
  new InjectionToken<TrustProviderRecoveryPort>('trust.provider-recovery', {
    factory: () => NO_PROVIDER_RECOVERY,
  });
