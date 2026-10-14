import { DOCUMENT } from '@angular/common';
import { DestroyRef, Directive, inject } from '@angular/core';
import {
  HostLifecycleService,
  HostSystemUiService,
} from '@trinity/runtime/host';
import {
  EMPTY,
  NEVER,
  Subscription,
  filter,
  fromEvent,
  merge,
  takeUntil,
} from 'rxjs';

/**
 * Counts an `<input type="file">`'s chooser as Trinity's own system UI, so App lock never
 * locks behind it. The count runs from the click that opens the chooser (the person's, or a
 * component's own `click()`) until `change` or `cancel`. The window getting focus back, or
 * the host reporting the app active again, also ends it, so a chooser whose end was missed
 * cannot keep the away timer off.
 */
@Directive({
  selector: 'input[type=file][trnTrackFileChooser]',
  host: {
    '(click)': 'opened()',
    '(change)': 'closed()',
    '(cancel)': 'closed()',
  },
})
export class TrackFileChooserDirective {
  private readonly systemUi = inject(HostSystemUiService);
  private readonly lifecycle = inject(HostLifecycleService);
  private readonly window = inject(DOCUMENT).defaultView;
  private span: Subscription | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.closed());
  }

  protected opened(): void {
    if (this.span && !this.span.closed) return;
    const back = merge(
      this.window ? fromEvent(this.window, 'focus') : EMPTY,
      this.lifecycle.events.pipe(filter((event) => event.kind === 'active')),
    );
    this.span = this.systemUi.track(NEVER).pipe(takeUntil(back)).subscribe();
  }

  protected closed(): void {
    this.span?.unsubscribe();
    this.span = null;
  }
}
