import {
  ChangeDetectionStrategy,
  Component,
  inject,
  output,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import { TrnSettingsGroupComponent } from '@trinity/components/overlay';
import { AdvancedSettingsResetService } from './advanced-settings-reset.service';

/**
 * The "Reset to defaults" group. The reset workflow is the advanced page's component-scoped
 * {@link AdvancedSettingsResetService}; a reset that changed anything announces
 * {@link discarded} so the page can drop an edit that no longer describes the app.
 */
@Component({
  selector: 'trn-config-reset-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './config-reset-group.component.html',
  host: { class: 'block' },
  imports: [TrnSettingsGroupComponent, TrnButton],
})
export class ConfigResetGroupComponent {
  private readonly workflow = inject(AdvancedSettingsResetService);

  readonly discarded = output<void>();

  protected readonly resetting = this.workflow.resetting;
  protected readonly resetResult = this.workflow.result;
  protected readonly outstandingResetEntries = this.workflow.outstandingEntries;

  protected reset(): void {
    this.workflow.start(() => this.discarded.emit());
  }

  protected retryReset(): void {
    this.workflow.retry(() => this.discarded.emit());
  }
}
