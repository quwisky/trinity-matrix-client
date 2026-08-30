import { ApplicationRef, ErrorHandler } from '@angular/core';
import { take } from 'rxjs';
import { ApplicationRuntimeService } from '../application-runtime.service';

/** Own Application Runtime's single lifetime subscription with the Angular application. */
export function startApplicationRuntime(applicationRef: ApplicationRef): void {
  const runtime = applicationRef.injector.get(ApplicationRuntimeService);
  const errors = applicationRef.injector.get(ErrorHandler);
  const runtimeSubscription = runtime
    .run()
    .subscribe({ error: (error: unknown) => errors.handleError(error) });

  applicationRef.onDestroy(() => {
    runtime.stop().pipe(take(1)).subscribe();
    runtimeSubscription.unsubscribe();
  });
}
