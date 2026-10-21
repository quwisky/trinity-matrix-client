import { ApplicationRef, ErrorHandler } from '@angular/core';
import { NativeKeyboardInsetAdapter } from '@trinity/platform-native';
import { take } from 'rxjs';
import { ApplicationRuntimeService } from '../application-runtime.service';
import { DiagnosticMarkersBinding } from './diagnostic-markers.binding';
import { SessionHandoverWorkflow } from './session-handover.workflow';

/**
 * Own Application Runtime's lifetime subscriptions with the Angular application: the session
 * handover, the runtime itself, the diagnostic log's lifecycle markers and the iOS keyboard inset.
 */
export function startApplicationRuntime(applicationRef: ApplicationRef): void {
  const runtime = applicationRef.injector.get(ApplicationRuntimeService);
  const errors = applicationRef.injector.get(ErrorHandler);
  // First, so another tab's "Use here" is heard from the moment this tab holds the lock.
  const handover = applicationRef.injector
    .get(SessionHandoverWorkflow)
    .run()
    .subscribe({ error: (error: unknown) => errors.handleError(error) });
  const runtimeSubscription = runtime
    .run()
    .subscribe({ error: (error: unknown) => errors.handleError(error) });
  const diagnosticMarkers = applicationRef.injector
    .get(DiagnosticMarkersBinding)
    .run()
    .subscribe({ error: (error: unknown) => errors.handleError(error) });
  const keyboardInset = applicationRef.injector
    .get(NativeKeyboardInsetAdapter)
    .run()
    .subscribe({ error: (error: unknown) => errors.handleError(error) });

  applicationRef.onDestroy(() => {
    runtime.stop().pipe(take(1)).subscribe();
    runtimeSubscription.unsubscribe();
    diagnosticMarkers.unsubscribe();
    handover.unsubscribe();
    keyboardInset.unsubscribe();
  });
}
