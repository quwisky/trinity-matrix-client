import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
  linkedSignal,
  output,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnButton } from '@trinity/components/controls';
import { TrnDialogActions } from '@trinity/components/overlay';
import { ExternalBrowserService } from '@trinity/platform-native';

/** A dialog step that completes re-authentication on the server's page in the browser. */
@Component({
  selector: 'trn-reauth-browser-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './reauth-browser-step.component.html',
  imports: [TrnButton, TrnDialogActions],
})
export class ReauthBrowserStepComponent {
  private readonly browser = inject(ExternalBrowserService);
  private readonly destroyRef = inject(DestroyRef);

  /** Prefixes the ids and test ids, so a dialog keeps its own. */
  readonly testIdPrefix = input.required<string>();
  readonly url = input.required<string>();
  /** True only after the person pressed Done once, so the page was already opened. */
  readonly pending = input(false);
  readonly body = input.required<string>();
  readonly pendingMessage = input.required<string>();
  readonly doneLabel = input.required<string>();
  /** Danger when Done completes a destructive action. */
  readonly variant = input<'danger' | 'primary'>('primary');

  readonly done = output<void>();
  readonly back = output<void>();

  protected readonly opened = linkedSignal(() => this.pending());

  protected open(): void {
    this.opened.set(true);
    this.browser
      .open(this.url())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }
}
