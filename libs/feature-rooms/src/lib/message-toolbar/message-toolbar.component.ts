import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { copyOutline, pencilOutline, trashOutline } from 'ionicons/icons';

/**
 * Discord-style floating action toolbar revealed when hovering a message.
 * Copy is always available; edit and delete are gated to the user's own messages.
 */
@Component({
  selector: 'trn-message-toolbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonIcon],
  templateUrl: './message-toolbar.component.html',
  styleUrl: './message-toolbar.component.scss',
})
export class MessageToolbarComponent {
  readonly canEdit = input(false);
  readonly canDelete = input(false);
  readonly copyMessage = output<void>();
  readonly editMessage = output<void>();
  readonly deleteMessage = output<void>();

  constructor() {
    addIcons({ copyOutline, pencilOutline, trashOutline });
  }
}
