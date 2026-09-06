import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import { AvatarComponent } from '@trinity/components/generic-content';
import { TrnOverlaySurfaceDirective } from '@trinity/components/overlay';

export interface SettingsHubSection {
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

/** Domain-neutral Account/target identity and responsive settings navigation shell. */
@Component({
  selector: 'trn-settings-hub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, TrnButton, TrnOverlaySurfaceDirective],
  templateUrl: './settings-hub.component.html',
  styleUrl: './settings-hub.component.scss',
})
export class SettingsHubComponent {
  readonly testId = input.required<string>();
  readonly noun = input.required<'Room' | 'Space'>();
  readonly accountId = input.required<string>();
  readonly accountName = input.required<string>();
  readonly accountAvatarMxc = input<string | null>(null);
  readonly accountInitial = input.required<string>();
  readonly targetName = input.required<string>();
  readonly targetAvatarMxc = input<string | null>(null);
  readonly targetInitial = input.required<string>();
  readonly sections = input.required<readonly SettingsHubSection[]>();
  readonly selectedSection = input.required<string>();
  readonly sectionTitle = input.required<string>();
  readonly compactNavigation = input(false);
  readonly directoryVisible = input(false);
  readonly mobileHost = input(false);
  readonly unavailableReason = input<string | null>(null);

  readonly sectionSelected = output<string>();
  readonly directoryRequested = output<void>();
  readonly closeRequested = output<void>();
}
