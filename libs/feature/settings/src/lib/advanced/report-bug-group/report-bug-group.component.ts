import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import {
  TrnSettingsGroupComponent,
  TrnSurfaceService,
} from '@trinity/components/overlay';
import { ReportBugDialogComponent } from '../report-bug/report-bug-dialog.component';

/**
 * Settings › Advanced › Report a problem. The sign-in screen, System status and the desktop
 * title bar open the same dialog through `BUG_REPORT_LAUNCHER`; here it opens directly.
 */
@Component({
  selector: 'trn-report-bug-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './report-bug-group.component.html',
  imports: [TrnButton, TrnSettingsGroupComponent],
})
export class ReportBugGroupComponent {
  private readonly surfaces = inject(TrnSurfaceService);

  openReport(): void {
    this.surfaces.open(ReportBugDialogComponent, {
      ariaLabel: 'Report a bug',
      autoFocus: '[data-autofocus]',
    });
  }
}
