import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { AvatarComponent } from '@trinity/components/generic-content';
import {
  GENERIC_BODY,
  type InboxRow,
} from '@trinity/data-access/notifications';
import { DateTimeFormatService } from '@trinity/platform-native';
import { initialOf } from '@trinity/util/matrix';

@Component({
  selector: 'trn-inbox-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent],
  templateUrl: './inbox-row.component.html',
  styleUrl: './inbox-row.component.scss',
})
export class InboxRowComponent {
  protected readonly fmt = inject(DateTimeFormatService);
  protected readonly initial = computed(() => initialOf(this.row().roomName));
  protected readonly previewText = computed(() => {
    const preview = this.row().preview;
    switch (preview.kind) {
      case 'text':
        return preview.text;
      case 'hidden':
        return GENERIC_BODY;
      case 'encrypted':
        return 'Encrypted message';
      case 'unavailable':
        return 'Preview unavailable';
    }
  });

  readonly row = input.required<InboxRow>();
  readonly unread = input(false);
  readonly current = input(false);
  readonly opened = output<void>();
}
