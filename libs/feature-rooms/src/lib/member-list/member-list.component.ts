import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX } from '@ng-icons/lucide';
import { AvatarComponent } from '@trinity/ui';
import { type MemberSummary } from '@trinity/data-access-rooms';

/** Discord member list (right column): joined members of the active room. */
@Component({
  selector: 'trn-member-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, NgIcon],
  viewProviders: [provideIcons({ lucideX })],
  templateUrl: './member-list.component.html',
  styleUrl: './member-list.component.scss',
})
export class MemberListComponent {
  readonly members = input<MemberSummary[]>([]);
  /** Hide the member list; the toolbar's members toggle reopens it. */
  readonly closed = output<void>();
}
