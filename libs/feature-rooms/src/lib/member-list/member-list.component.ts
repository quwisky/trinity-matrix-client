import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { AvatarComponent } from '../avatar/avatar.component';
import type { MemberSummary } from '@trinity/core';

/** Discord member list (right column): joined members of the active room. */
@Component({
  selector: 'app-member-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent],
  template: `
    <aside class="members">
      <div class="category">Members — {{ members().length }}</div>
      @for (member of members(); track member.userId) {
        <div class="member" [title]="member.userId">
          <app-avatar
            [url]="member.avatarUrl"
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
}
