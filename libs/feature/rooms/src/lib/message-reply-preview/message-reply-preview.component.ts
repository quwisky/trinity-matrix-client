import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { AvatarComponent } from '@trinity/components/generic-content';
import { type ReplyPreview } from '@trinity/data-access/timeline';

@Component({
  selector: 'trn-message-reply-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent],
  templateUrl: './message-reply-preview.component.html',
  styleUrl: './message-reply-preview.component.scss',
})
export class MessageReplyPreviewComponent {
  readonly reply = input.required<ReplyPreview>();
  readonly jump = output<string>();
}
