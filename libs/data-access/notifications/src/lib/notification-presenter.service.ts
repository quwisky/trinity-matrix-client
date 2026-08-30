import { Injectable, inject } from '@angular/core';
import {
  HostNotificationPresentationService,
  type HostCapabilitySupport,
  type HostOperationOutcome,
} from '@trinity/runtime/host';
import { Observable, defer } from 'rxjs';
import type {
  NotificationDestination,
  NotificationIntent,
} from './notification-intent';

/** Delivers typed intents and returns typed activations through Host Capabilities. */
@Injectable({ providedIn: 'root' })
export class NotificationPresenterService {
  private readonly host = inject(HostNotificationPresentationService);

  readonly activated: Observable<NotificationDestination> = this.host.activated;

  support(): Observable<HostCapabilitySupport> {
    return defer(() => this.host.support());
  }

  requestPermission(): Observable<HostOperationOutcome> {
    return defer(() => this.host.requestPermission());
  }

  present(intent: NotificationIntent): Observable<HostOperationOutcome> {
    return defer(() =>
      this.host.present({
        title: intent.title,
        body: intent.body,
        tag: intent.tag,
        silent: intent.silent,
        destination: intent.destination,
      }),
    );
  }
}
