import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { AvatarComponent } from '@trinity/components/generic-content';
import { type ReplyPreview } from '@trinity/data-access/timeline';
import { UnencryptedMarkComponent } from '../shared/unencrypted-mark/unencrypted-mark.component';

@Component({
  selector: 'trn-message-reply-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, UnencryptedMarkComponent],
  templateUrl: './message-reply-preview.component.html',
  styleUrl: './message-reply-preview.component.scss',
})
export class MessageReplyPreviewComponent {
  readonly reply = input.required<ReplyPreview>();
  readonly jump = output<string>();
  readonly label = computed(() => {
    const { senderName, shield } = this.reply();
    return `Replying to ${senderName}${shield ? `, ${shield.reason.toLowerCase()} message` : ''}`;
  });
}
