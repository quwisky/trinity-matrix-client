import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { type ReactionView } from '@trinity/util-matrix';

/** Reaction pills under a message; clicking one toggles the user's own reaction. */
@Component({
  selector: 'trn-message-reactions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './message-reactions.component.html',
  styleUrl: './message-reactions.component.scss',
})
export class MessageReactionsComponent {
  readonly reactions = input<ReactionView[]>([]);
  readonly toggleReaction = output<string>();
}
