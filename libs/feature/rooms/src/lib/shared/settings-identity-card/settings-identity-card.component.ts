import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'trn-settings-identity-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings-identity-card.component.html',
  styleUrl: './settings-identity-card.component.scss',
})
export class SettingsIdentityCardComponent {
  readonly heading = input.required<string>();
  readonly permissionReason = input<string | null>(null);
}
