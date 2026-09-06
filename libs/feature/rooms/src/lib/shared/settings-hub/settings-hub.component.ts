import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import type { TrnIconName } from '@trinity/components/foundations';
import {
  TrnSettingsLayoutComponent,
  type TrnSettingsLayoutSection,
} from '@trinity/components/overlay';

export interface SettingsHubSection {
  readonly value: string;
  readonly label: string;
  readonly description: string;
  readonly icon: TrnIconName;
  readonly group: string;
}

/** Room/Space context inside the same presentation shell as application Settings. */
@Component({
  selector: 'trn-settings-hub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnSettingsLayoutComponent],
  templateUrl: './settings-hub.component.html',
  styleUrl: './settings-hub.component.scss',
})
export class SettingsHubComponent {
  readonly testId = input.required<string>();
  readonly noun = input.required<'Room' | 'Space'>();
  readonly accountName = input.required<string>();
  readonly targetName = input.required<string>();
  readonly sections = input.required<readonly SettingsHubSection[]>();
  readonly selectedSection = input.required<string>();
  readonly sectionTitle = input.required<string>();
  readonly compactNavigation = input(false);
  readonly directoryVisible = input(false);
  readonly unavailableReason = input<string | null>(null);
  readonly navigation = computed<readonly TrnSettingsLayoutSection[]>(() =>
    this.sections().map(({ value, label, icon, group }) => ({
      id: value,
      label,
      icon,
      group,
    })),
  );
  readonly sectionDescription = computed(
    () =>
      this.sections().find(({ value }) => value === this.selectedSection())
        ?.description,
  );

  readonly sectionSelected = output<string>();
  readonly directoryRequested = output<void>();
  readonly closeRequested = output<void>();
}
