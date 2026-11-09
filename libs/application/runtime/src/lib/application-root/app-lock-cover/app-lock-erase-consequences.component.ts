import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TrnIconComponent } from '@trinity/components/foundations';

/** What erasing all data loses, as `#app-lock-erase-text`: the erase button's description. */
@Component({
  selector: 'trn-app-lock-erase-consequences',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app-lock-erase-consequences.component.html',
  imports: [TrnIconComponent],
})
export class AppLockEraseConsequencesComponent {
  /** Why erasing is the way back, said first; null when it is a choice. */
  readonly lead = input<string | null>(null);
  readonly turnsOffHello = input(false);
}
