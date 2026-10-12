import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  TrnSurfaceService,
  TrnToastService,
  type TrnDialogRef,
} from '@trinity/components/overlay';
import type { BugReportLauncher } from '@trinity/platform-native';
import { defer, finalize, take } from 'rxjs';
import { REPORT_BUG_DIALOG_COMPONENT } from '../application-dialog-loaders';

/**
 * `BUG_REPORT_LAUNCHER` for the sign-in screen and System status. The application host
 * supplies the dialog lazily from feature-settings, as it does Settings
 * (`APPLICATION_DIALOG_LOADERS`); this opens it as a surface over whatever is showing, so
 * focus returns to the button that asked. One report at a time.
 */
@Injectable({ providedIn: 'root' })
export class ReportBugLauncherAdapter implements BugReportLauncher {
  private readonly load = inject(REPORT_BUG_DIALOG_COMPONENT);
  private readonly surfaces = inject(TrnSurfaceService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);
  private loading = false;
  private current: TrnDialogRef<unknown> | null = null;

  open(): void {
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
            ariaLabel: 'Report a bug',
            autoFocus: '[data-autofocus]',
          });
          this.current = ref;
          ref.closed.pipe(take(1)).subscribe(() => {
            if (this.current === ref) {
              this.current = null;
            }
          });
        },
        error: () =>
          this.toast.show('Couldn’t open Report a bug. Try again.', {
            duration: 5000,
            variant: 'danger',
          }),
      });
  }
}
