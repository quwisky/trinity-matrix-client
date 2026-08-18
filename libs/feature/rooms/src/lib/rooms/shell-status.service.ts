import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { TrnToastService } from '@trinity/components/overlay';
import type { BusyState } from '@trinity/util/ui';

/**
 * The rooms shell's single busy/error channel, and the toasts it drives.
 *
 * The field names are not incidental: `busy`, `error` and `destroyRef` make an instance
 * structurally assignable to {@link BusyState}, so every call site is
 * `runWithBusy(source, this.status)` rather than rebuilding the same three-field object.
 *
 * There is exactly ONE of these per page, and that is the invariant worth protecting.
 * The signals it replaced were named `spaceBusy`/`spaceError` but were written by room
 * creation, invites and DM start as well, with a single effect toasting whenever the error
 * turned non-null. Giving each extracted coordinator its own pair would turn one effect
 * into N and change what a user sees when two actions fail together.
 * `shell-invariants.spec.ts` pins the dedupe: two failures in one flush toast once, two
 * flushes toast twice, and an identical message toasts again because `runWithBusy` nulls
 * the error synchronously before each run.
 *
 * Page-scoped like {@link RoomShellStore} — `runWithBusy` ties its subscription to
 * `destroyRef`, so a root-provided instance would leak every one of them past teardown.
 */
@Injectable()
export class ShellStatusService implements BusyState {
  private readonly toast = inject(TrnToastService);

  /**
   * Whether a shell action is in flight.
   *
   * Write-only today: `runWithBusy` sets it, and nothing in `libs`, `apps`, `e2e`, the
   * template or the spec reads it. It cannot simply be dropped because `BusyState`
   * requires the field, and it is the natural place to hang a spinner if one is ever
   * wanted — but do not assume anything is watching it.
   */
  readonly busy = signal(false);

  /** Last shell-action failure, surfaced as a toast by the page's effect; null when clear. */
  readonly error = signal<string | null>(null);

  readonly destroyRef = inject(DestroyRef);

  showError(message: string): void {
    this.toast.show(message, { duration: 4000, variant: 'destructive' });
  }

  showSuccess(message: string): void {
    this.toast.show(message, { duration: 3000, variant: 'success' });
  }
}
