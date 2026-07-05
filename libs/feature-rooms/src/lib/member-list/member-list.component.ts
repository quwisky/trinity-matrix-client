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
  template: `
    <aside class="members">
      <div class="members__header">
        <span class="category">Members — {{ members().length }}</span>
        <button
          class="members__close"
          (click)="closed.emit()"
          aria-label="Close member list"
          title="Close member list"
          data-testid="close-members"
        >
          <ng-icon name="lucideX" aria-hidden="true" />
        </button>
      </div>
      @for (member of members(); track member.userId) {
        <div class="member" [title]="member.userId">
          <trn-avatar
            [mxc]="member.avatarMxc"
            [initial]="member.initial"
            [name]="member.name"
            [size]="32"
          />
          <span class="member__name">{{ member.name }}</span>
        </div>
      }
    </aside>
  `,
  styleUrl: './member-list.component.scss',
})
export class MemberListComponent {
  readonly members = input<MemberSummary[]>([]);
  /** Hide the member list; the toolbar's members toggle reopens it. */
  readonly closed = output<void>();
}
