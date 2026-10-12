import { ApplicationRef, ErrorHandler } from '@angular/core';
import { take } from 'rxjs';
import { ApplicationRuntimeService } from '../application-runtime.service';
import { DiagnosticMarkersBinding } from './diagnostic-markers.binding';

/**
 * Own Application Runtime's lifetime subscriptions with the Angular application: the
 * runtime itself and the diagnostic log's lifecycle markers.
 */
export function startApplicationRuntime(applicationRef: ApplicationRef): void {
  const runtime = applicationRef.injector.get(ApplicationRuntimeService);
  const errors = applicationRef.injector.get(ErrorHandler);
  const runtimeSubscription = runtime
    .run()
    .subscribe({ error: (error: unknown) => errors.handleError(error) });
  const diagnosticMarkers = applicationRef.injector
    .get(DiagnosticMarkersBinding)
    .run()
    .subscribe({ error: (error: unknown) => errors.handleError(error) });

  applicationRef.onDestroy(() => {
    runtime.stop().pipe(take(1)).subscribe();
    runtimeSubscription.unsubscribe();
    diagnosticMarkers.unsubscribe();
  });
}
