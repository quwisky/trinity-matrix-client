import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  TrnSurfaceService,
  type TrnDialogRef,
} from '@trinity/components/overlay';
import { DiagnosticLogService } from '@trinity/data-access/diagnostic-log';
import {
  WhatsNewService,
  type ReleaseNote,
  type WhatsNewLauncher,
} from '@trinity/data-access/whats-new';
import {
  EMPTY,
  catchError,
  concat,
  defer,
  filter,
  finalize,
  ignoreElements,
  switchMap,
  take,
  type Observable,
} from 'rxjs';
import { WHATS_NEW_DIALOG_COMPONENT } from '../application-dialog-loaders';

/**
 * `WHATS_NEW_LAUNCHER`, and the one-time dialog after an update. The application host supplies
 * the dialog lazily from feature-whats-new (`APPLICATION_DIALOG_LOADERS`). One dialog at a time.
 */
@Injectable({ providedIn: 'root' })
export class WhatsNewLauncherAdapter implements WhatsNewLauncher {
  private readonly load = inject(WHATS_NEW_DIALOG_COMPONENT);
  private readonly surfaces = inject(TrnSurfaceService);
  private readonly whatsNew = inject(WhatsNewService);
  private readonly log = inject(DiagnosticLogService);
  private readonly destroyRef = inject(DestroyRef);
  private loading = false;
  private current: TrnDialogRef<unknown> | null = null;

  /** Opens the notes newer than the last-seen version, once; completes without emitting. */
  runPending(): Observable<never> {
    return this.whatsNew.pending().pipe(
      filter((releases) => releases.length > 0),
      switchMap((releases) =>
        concat(
          this.whatsNew.markSeen().pipe(ignoreElements()),
          defer(() => {
            this.open(releases);
            return EMPTY;
          }),
        ),
      ),
      // A storage failure skips the dialog; it must not end the live session.
      catchError(() => EMPTY),
    );
  }

  showAll(): void {
    if (this.whatsNew.all.length > 0) this.open(this.whatsNew.all);
  }

  private open(releases: readonly ReleaseNote[]): void {
    if (this.loading || this.current) {
      return;
    }
    this.loading = true;
    defer(this.load)
      .pipe(
        take(1),
        finalize(() => (this.loading = false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (component) => {
          const ref = this.surfaces.open(component, {
            ariaLabel: 'What’s new in Trinity',
            autoFocus: 'first-heading',
            inputs: { releases },
          });
          this.current = ref;
          ref.closed.pipe(take(1)).subscribe(() => {
            if (this.current === ref) {
              this.current = null;
            }
          });
        },
        error: () =>
          this.log.record({
            level: 'warn',
            source: 'app',
            logger: 'whats-new',
            message: 'The What’s new dialog could not be loaded.',
          }),
      });
  }
}
