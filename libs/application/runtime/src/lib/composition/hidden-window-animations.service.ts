import { DOCUMENT, Injectable, inject } from '@angular/core';
import { HostLifecycleService } from '@trinity/runtime/host';
import { Observable, finalize, ignoreElements, tap } from 'rxjs';

const HIDDEN = 'data-window-hidden';

/**
 * Marks the root while the app is hidden, so `global.scss` pauses animations. A hidden desktop
 * window keeps rendering because the shell turns background throttling off for `/sync`; a
 * browser or phone already stops painting, so there the mark changes nothing.
 */
@Injectable({ providedIn: 'root' })
export class HiddenWindowAnimations {
  private readonly lifecycle = inject(HostLifecycleService);
  private readonly root = inject(DOCUMENT).documentElement;

  run(): Observable<never> {
    return this.lifecycle.events.pipe(
      tap((event) =>
        this.root.toggleAttribute(HIDDEN, event.kind === 'background'),
      ),
      finalize(() => this.root.removeAttribute(HIDDEN)),
      ignoreElements(),
    );
  }
}
