import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
} from '@angular/core';
import { AvatarComponent } from '@trinity/components/generic-content';
import {
  TrnDialogRef,
  TrnDialogShellComponent,
} from '@trinity/components/overlay';
import { IdentityChangeActionsComponent } from './identity-change-actions.component';
import { identityChangeStatus } from './identity-change-copy';
import { RoomIdentityChangesService } from './room-identity-changes.service';

/** Everyone in a room whose identity changed, each with their own actions. Closes once empty. */
@Component({
  selector: 'trn-identity-change-review',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AvatarComponent,
    IdentityChangeActionsComponent,
    TrnDialogShellComponent,
  ],
  templateUrl: './identity-change-review.component.html',
})
export class IdentityChangeReviewComponent {
  private readonly dialogRef = inject<TrnDialogRef<void>>(TrnDialogRef);
  private readonly changesService = inject(RoomIdentityChangesService);

  readonly roomKey = input.required<{ accountId: string; roomId: string }>();

  protected readonly changes = computed(() =>
    this.changesService.changes(this.roomKey()),
  );
  protected readonly status = identityChangeStatus;

  constructor() {
    effect(() => {
      if (this.changes().length === 0) this.close();
    });
  }

  close(): void {
    this.dialogRef.close();
  }
}
