import { Injectable, InjectionToken, inject } from '@angular/core';
import { Observable, defaultIfEmpty, defer, of, take } from 'rxjs';
import {
  type HostCapabilityManifest,
  unavailableHostManifest,
} from './host-capability.models';

/** Adapter selected by a host composition root, never by product code. */
export interface HostCapabilityNegotiator {
  manifest(): Observable<HostCapabilityManifest>;
}

export const HOST_CAPABILITY_NEGOTIATOR =
  new InjectionToken<HostCapabilityNegotiator>('HOST_CAPABILITY_NEGOTIATOR');

/** The finite, versioned host-capability negotiation interface. */
@Injectable({ providedIn: 'root' })
export class HostCapabilitiesService {
  private readonly negotiator = inject(HOST_CAPABILITY_NEGOTIATOR, {
    optional: true,
  });

  manifest(): Observable<HostCapabilityManifest> {
    return defer(() =>
      this.negotiator
        ? this.negotiator.manifest().pipe(
            take(1),
            defaultIfEmpty(
              unavailableHostManifest('host-rejected', {
                code: 'empty-negotiation',
              }),
            ),
          )
        : of(unavailableHostManifest('not-implemented')),
    );
  }
}
