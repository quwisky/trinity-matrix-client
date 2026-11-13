import { Injectable, InjectionToken, inject } from '@angular/core';
import {
  Observable,
  Subject,
  defaultIfEmpty,
  defer,
  of,
  switchMap,
  take,
  tap,
} from 'rxjs';
import {
  type HostCapabilityManifest,
  hostNegotiationRejected,
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

  private readonly recoveries = new Subject<HostCapabilityManifest>();
  private failed = false;
  private succeeded = false;

  /** The host's answer each time one follows a failed negotiation, for readers that settled on the failure. */
  readonly recovered = this.recoveries.asObservable();

  /**
   * The host has answered a negotiation that did not fail as a whole, so what it lacks is
   * known to be lacking. False before the first answer and while the last one failed; true
   * where no host negotiates.
   */
  get negotiationAnswered(): boolean {
    return !this.negotiator || this.succeeded;
  }

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
            tap((manifest) => {
              const recovered = this.failed;
              this.failed = hostNegotiationRejected(manifest);
              this.succeeded = !this.failed;
              if (recovered && !this.failed) this.recoveries.next(manifest);
            }),
          )
        : of(unavailableHostManifest('not-implemented')),
    );
  }

  /**
   * `manifest()` for a reader that outlives startup: after a failed negotiation it waits
   * for the answer a later `manifest()` reader gets (startup's Retry) instead of asking again.
   */
  answered(): Observable<HostCapabilityManifest> {
    return this.manifest().pipe(
      switchMap((manifest) =>
        hostNegotiationRejected(manifest)
          ? this.recovered.pipe(take(1))
          : of(manifest),
      ),
    );
  }
}
