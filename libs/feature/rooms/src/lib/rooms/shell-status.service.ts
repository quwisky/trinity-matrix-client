import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { TrnToastService } from '@trinity/components/overlay';
import type { BusyState } from '@trinity/util/ui';

/**
 * The rooms shell's single busy/error channel, and the toasts it drives.
 *
 * `busy`, `error` and `destroyRef` make an instance structurally assignable to
 * {@link BusyState}, so call sites are `runWithBusy(source, this.status)`.
 *
 * There must be exactly ONE of these per page: one effect toasts whenever the error turns
 * non-null, and a pair per coordinator would turn it into N and change what a user sees when
 * two actions fail together. Error presentation is queued here rather than left to a
 * component effect because the app is zoneless: a failure that changes no template-read
 * signal may not schedule another render pass. `shell-invariants.spec.ts` pins the dedupe:
 * two failures in one turn toast once, two turns toast twice, and an identical message toasts
 * again because `runWithBusy` nulls the error synchronously before each run.
 *
 * Page-scoped like {@link RoomShellStore}: `runWithBusy` ties its subscription to
 * `destroyRef`, so a root-provided instance would leak every one past teardown.
 */
@Injectable()
export class ShellStatusService implements BusyState {
  private readonly toast = inject(TrnToastService);

  /**
   * Whether a shell action is in flight.
   *
   * Write-only: `runWithBusy` sets it and nothing reads it, but `BusyState` requires the
   * field. Do not assume anything is watching it.
   */
  readonly busy = signal(false);

  /** Last shell-action failure, surfaced as a toast by the page's effect; null when clear. */
  readonly error = signal<string | null>(null);

  readonly destroyRef = inject(DestroyRef);
  private errorPresentationQueued = false;

  /**
   * Queue one toast per turn and read the latest captured error when it runs. This keeps
   * simultaneous shell failures deduplicated without depending on Angular change
   * detection to run a component effect in the zoneless app.
   */
  presentError(): void {
    if (this.errorPresentationQueued) return;
    this.errorPresentationQueued = true;
    queueMicrotask(() => {
      this.errorPresentationQueued = false;
      if (this.destroyRef.destroyed) return;
      const message = this.error();
      if (message) this.showError(message);
    });
  }

  showError(message: string): void {
    this.toast.show(message, { duration: 4000, variant: 'danger' });
  }

  showSuccess(message: string): void {
    this.toast.show(message, { duration: 3000, variant: 'success' });
  }

  showWarning(message: string): void {
    this.toast.show(message, { duration: 6000, variant: 'warning' });
  }
}
