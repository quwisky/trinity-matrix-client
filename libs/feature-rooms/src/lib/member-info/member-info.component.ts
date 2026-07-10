import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { HlmButton } from '@trinity/helm/button';
import { DialogRef, TrnToastService } from '@trinity/helm/overlay';
import { type MemberSummary } from '@trinity/data-access-rooms';
import { PresenceService } from '@trinity/data-access-profile';
import { AvatarComponent } from '@trinity/ui';

/**
 * A room-scoped info panel for a member (avatar, name, id, live presence, role), shown
 * when a member row is clicked. It is the launch surface for member actions: today it
 * offers **Message** (closes resolving the user id so the host opens/reuses a DM) and
 * **Copy user ID**; kick / ban / power-level / verify hang off here later. Owns
 * presentation only — the DM itself is the host's job.
 */
@Component({
  selector: 'trn-member-info',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, HlmButton],
  templateUrl: './member-info.component.html',
  styleUrl: './member-info.component.scss',
})
export class MemberInfoComponent {
  readonly member = input.required<MemberSummary>();
  /** The room the member is being viewed in (for room-scoped actions added later). */
  readonly roomId = input.required<string>();

  private readonly dialogRef =
    inject<DialogRef<string | null, MemberInfoComponent>>(DialogRef);
  private readonly presence = inject(PresenceService);
  private readonly toast = inject(TrnToastService);

  /** Live online status for the presence dot. */
  readonly presenceState = computed(() =>
    this.presence.presenceFor(this.member().userId)(),
  );

  /** The member's role in the room, by the standard power-level convention. */
  readonly role = computed(() => {
    const power = this.member().powerLevel;
    if (power >= 100) {
      return 'Admin';
    }
    return power >= 50 ? 'Moderator' : 'Member';
  });

  /** Start (or reuse) a direct message with this member — the host does the navigation. */
  message(): void {
    this.dialogRef.close(this.member().userId);
  }

  /** Copy the member's user id to the clipboard, confirming with a toast. */
  copyId(): void {
    void navigator.clipboard?.writeText(this.member().userId);
    this.toast.show('User ID copied.', { duration: 2000 });
  }

  close(): void {
    this.dialogRef.close(null);
  }
}
