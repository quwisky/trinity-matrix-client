import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormRoot } from '@angular/forms/signals';
import {
  TrnButton,
  TrnRadioGroupComponent,
} from '@trinity/components/controls';
import { SpaceSettingsForYouDraftService } from './space-settings-for-you-draft.service';
import { SettingsLoadStateCardComponent } from '../../shared/settings-load-state-card/settings-load-state-card.component';

@Component({
  selector: 'trn-space-settings-for-you',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormRoot,
    TrnButton,
    TrnRadioGroupComponent,
    SettingsLoadStateCardComponent,
  ],
  templateUrl: './space-settings-for-you.component.html',
  styleUrl: './space-settings-for-you.component.scss',
})
export class SpaceSettingsForYouComponent {
  readonly draft = inject(SpaceSettingsForYouDraftService);
}
