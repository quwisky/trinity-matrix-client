import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { AvatarComponent, TrnBadge } from '@trinity/components/generic-content';
import { relativeTimeLabel } from '../../shared/relative-time';
import { type RailUnreadChat } from '../rail-unread-chats';

/**
 * One chat in the list "+N" opens: the rail entry's avatar and count, with the name and a
 * line naming the account (when badged) and the last activity beside them.
 *
 * Content only; the menu item or sheet button around it owns the action and its name. The
 * time is read when the row renders, since the list is open only briefly.
 */
@Component({
  selector: 'trn-rail-unread-overflow-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, TrnBadge],
  templateUrl: './rail-unread-overflow-row.component.html',
  host: { class: 'flex w-full min-w-0 items-center gap-3 text-start' },
})
export class RailUnreadOverflowRowComponent {
  private readonly renderedAt = Date.now();

  readonly chat = input.required<RailUnreadChat>();

  /** "{account} · {when}"; a chat only marked unread reads "Marked unread" for the time. */
  protected readonly detail = computed(() => {
    const chat = this.chat();
    const when =
      chat.countLabel === null
        ? 'Marked unread'
        : chat.activityTs > 0
          ? relativeTimeLabel(chat.activityTs, this.renderedAt)
          : null;
    return [chat.accountBadge?.name, when].filter(Boolean).join(' · ');
  });
}
