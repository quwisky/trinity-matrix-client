import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { FormField, FormRoot } from '@angular/forms/signals';
import {
  TrnActionAvailability,
  TrnButton,
  TrnInput,
  TrnTextarea,
} from '@trinity/components/controls';
import { TrnTooltip } from '@trinity/components/generic-content';
import { initialOf } from '@trinity/util/matrix';
import { AvatarFieldComponent } from '../shared/avatar-field/avatar-field.component';
import { RoomSettingsDraftService } from './room-settings-draft.service';

/** General Room profile editor backed by the hub's exact-target draft lifetime. */
@Component({
  selector: 'trn-room-settings-general',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AvatarFieldComponent,
    FormField,
    FormRoot,
    TrnActionAvailability,
    TrnButton,
    TrnInput,
    TrnTextarea,
    TrnTooltip,
  ],
  templateUrl: './room-settings-general.component.html',
  styleUrl: './room-settings-general.component.scss',
})
export class RoomSettingsGeneralComponent {
  readonly accountId = input.required<string>();
  readonly roomId = input.required<string>();
  readonly roomDisplayName = input('Room');
  readonly draft = inject(RoomSettingsDraftService);

  readonly roomInitial = computed(() =>
    initialOf(this.draft.model().name || this.roomDisplayName()),
  );
  readonly encryptionStatus = computed(() => {
    const encrypted = this.draft.snapshot()?.encrypted;
    if (encrypted === null || encrypted === undefined) {
      return 'Encryption status is unavailable.';
    }
    return encrypted
      ? 'Messages in this Room are end-to-end encrypted.'
      : 'Messages in this Room are not end-to-end encrypted.';
  });
}
