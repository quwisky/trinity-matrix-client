import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
} from '@angular/core';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import { TrnButton } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import { BannerComponent } from '@trinity/components/generic-content';
import {
  RoomActionPermissionsService,
  RoomMembersService,
} from '@trinity/data-access/room-administration';
import { ConversationRuntime } from '@trinity/data-access/timeline';

/** Room banner telling people who can approve that someone asked to join the open room. */
@Component({
  selector: 'trn-join-requests-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BannerComponent, TrnButton, TrnIconComponent],
  templateUrl: './join-requests-banner.component.html',
})
export class JoinRequestsBannerComponent {
  private readonly runtime = inject(ConversationRuntime);
  private readonly members = inject(RoomMembersService);
  private readonly permissions = inject(RoomActionPermissionsService);
  private readonly workspace = inject(WorkspaceNavigationService);

  private readonly key = computed(() => {
    const key = this.runtime.focused()?.key;
    return key && key.accountId === this.workspace.activeAccountId()
      ? key
      : null;
  });
  protected readonly message = computed(() => {
    const key = this.key();
    if (!key || !this.permissions.roomFor(key).invite.available) return '';
    const requests = this.members.knockingFor(key.roomId)();
    const [only] = requests;
    if (!only) return '';
    return requests.length === 1
      ? `${only.roomDisplayName} asked to join.`
      : `${requests.length} people asked to join.`;
  });

  readonly review = output<void>();
}
