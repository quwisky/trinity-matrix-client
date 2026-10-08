import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { TrnSettingsGroupComponent } from '@trinity/components/overlay';
import { PlaceGeneralSettingsComponent } from '../shared/place-general-settings/place-general-settings.component';
import { RoomSettingsDraftService } from './room-settings-draft.service';

/** General Room profile editor backed by the hub's exact-target draft lifetime. */
@Component({
  selector: 'trn-room-settings-general',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PlaceGeneralSettingsComponent, TrnSettingsGroupComponent],
  templateUrl: './room-settings-general.component.html',
  styleUrl: './room-settings-general.component.scss',
})
export class RoomSettingsGeneralComponent {
  readonly accountId = input.required<string>();
  readonly roomId = input.required<string>();
  readonly roomDisplayName = input('Room');
  readonly draft = inject(RoomSettingsDraftService);

  readonly encryptionStatus = computed(() => {
    const encrypted = this.draft.snapshot()?.encrypted;
    if (encrypted === null || encrypted === undefined) {
      return 'Encryption status is unavailable.';
    }
    return encrypted
      ? 'Messages in this room are end-to-end encrypted.'
      : 'Messages in this room are not end-to-end encrypted.';
  });
}
