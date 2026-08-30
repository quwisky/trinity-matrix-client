import {
  RoomLinkService,
  type RoomLinkAction,
  type RoomLinkPreview,
  type RoomLinkPreviewFailure,
} from '@trinity/data-access/discovery';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AvatarComponent } from '@trinity/components/avatar';
import { TrnButton } from '@trinity/components/button';
import { TrnIconComponent } from '@trinity/components/icon';
import { TrnDialogRef } from '@trinity/components/overlay';
import { TrnSpinnerComponent } from '@trinity/components/spinner';
import { InvitesService } from '@trinity/data-access/room-library';
import { describeRoomLinkPreviewFailure } from '@trinity/data-access/discovery';
import {
  describeMatrixRequestFailure,
  reportMatrixRequestFailure,
  type MatrixLinkTarget,
} from '@trinity/util/matrix';
import { finalize, map, type Observable } from 'rxjs';

export interface RoomLinkPreviewResult {
  readonly roomId: string;
  readonly isSpace: boolean;
  /** True only after this surface completed Join/Accept; synced sidebars may still lag. */
  readonly membershipChanged: boolean;
}

/** Accessible room information and explicit membership-action surface. */
@Component({
  selector: 'trn-room-link-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, TrnButton, TrnIconComponent, TrnSpinnerComponent],
  templateUrl: './room-link-preview.component.html',
  styleUrl: './room-link-preview.component.scss',
  host: {
    '[class.room-link-preview--sheet]': 'sheet()',
  },
})
export class RoomLinkPreviewComponent implements OnInit {
  readonly target =
    input.required<Extract<MatrixLinkTarget, { kind: 'room' }>>();
  readonly sheet = input(false);
  readonly closeButton =
    viewChild.required<ElementRef<HTMLButtonElement>>('closeButton');

  private readonly dialogRef =
    inject<TrnDialogRef<RoomLinkPreviewResult | null>>(TrnDialogRef);
  private readonly roomLinks = inject(RoomLinkService);
  private readonly invites = inject(InvitesService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly preview = signal<RoomLinkPreview | null>(null);
  readonly loadFailure = signal<RoomLinkPreviewFailure | null>(null);
  readonly acting = signal(false);
  readonly actionError = signal<string | null>(null);
  readonly success = signal<string | null>(null);
  private readonly membershipChanged = signal(false);

  readonly displayAddress = computed(() => {
    const preview = this.preview();
    return preview?.canonicalAddress ?? preview?.requestedAddress ?? null;
  });

  readonly primaryAction = computed<RoomLinkAction>(
    () => this.preview()?.action ?? 'none',
  );

  readonly joinRuleLabel = computed(() => {
    switch (this.preview()?.joinRule) {
      case 'public':
        return 'Anyone can join';
      case 'knock':
        return 'Request to join';
      case 'knock_restricted':
        return this.preview()?.action === 'join'
          ? 'Restricted — you can join'
          : 'Request to join';
      case 'restricted':
        return 'Restricted';
      case 'invite':
      case 'private':
        return 'Invite only';
      default:
        return 'Not provided';
    }
  });

  readonly unavailableMessage = computed(() => {
    const preview = this.preview();
    if (!preview || preview.action !== 'none' || this.success()) return null;
    if (preview.membership === 'knock') {
      return 'Your request to join is pending.';
    }
    if (preview.membership === 'ban') {
      return 'You cannot join this room with the current account.';
    }
    if (preview.joinRule === 'restricted') {
      return 'Membership is restricted. Join through an allowed space or ask a member for access.';
    }
    if (preview.joinRule === 'invite' || preview.joinRule === 'private') {
      return 'This room is invite only. Ask a member for an invitation.';
    }
    return 'This room does not advertise a way for the current account to join.';
  });

  ngOnInit(): void {
    this.load();
  }

  retry(): void {
    // Retry temporarily removes its own control. Move focus to the stable Close
    // button first so keyboard and screen-reader users never fall back to <body>.
    this.closeButton().nativeElement.focus();
    this.load();
  }

  runPrimaryAction(): void {
    const preview = this.preview();
    if (!preview || this.acting()) return;
    if (preview.action === 'open') {
      this.dialogRef.close({
        roomId: preview.roomId,
        isSpace: preview.isSpace,
        membershipChanged: this.membershipChanged(),
      });
      return;
    }

    const request = this.actionRequest(preview);
    if (!request) return;
    this.acting.set(true);
    this.actionError.set(null);
    this.success.set(null);
    request
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.acting.set(false)),
      )
      .subscribe({
        next: (roomId) => this.actionSucceeded(preview, roomId),
        error: (error: unknown) => this.actionFailed(preview.action, error),
      });
  }

  close(): void {
    this.dialogRef.close(null);
  }

  private load(): void {
    this.loading.set(true);
    this.preview.set(null);
    this.loadFailure.set(null);
    this.actionError.set(null);
    this.success.set(null);
    this.roomLinks
      .preview(this.target())
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.loading.set(false)),
      )
      .subscribe({
        next: (preview) => this.preview.set(preview),
        error: (error: unknown) => {
          reportMatrixRequestFailure('preview linked room', error);
          this.loadFailure.set(describeRoomLinkPreviewFailure(error));
        },
      });
  }

  private actionRequest(
    preview: RoomLinkPreview,
  ): Observable<string | null> | null {
    if (preview.action === 'join') {
      return this.roomLinks.join(preview);
    }
    if (preview.action === 'accept') {
      return this.invites
        .acceptInvite(preview.roomId)
        .pipe(map(() => preview.roomId));
    }
    if (preview.action === 'knock') {
      return this.roomLinks.knock(preview).pipe(map(() => null));
    }
    return null;
  }

  private actionSucceeded(
    preview: RoomLinkPreview,
    roomId: string | null,
  ): void {
    if (preview.action === 'knock') {
      this.preview.set({ ...preview, membership: 'knock', action: 'none' });
      this.success.set('Request sent. A room moderator can now approve it.');
      return;
    }
    this.preview.set({
      ...preview,
      roomId: roomId ?? preview.roomId,
      membership: 'join',
      action: 'open',
    });
    this.membershipChanged.set(true);
    this.success.set(
      preview.action === 'accept'
        ? 'Invitation accepted. The room is ready to open.'
        : 'Room joined. It is ready to open.',
    );
  }

  private actionFailed(action: RoomLinkAction, error: unknown): void {
    const operation =
      action === 'accept'
        ? 'accept linked room invitation'
        : action === 'knock'
          ? 'request access to linked room'
          : 'join linked room';
    reportMatrixRequestFailure(operation, error);
    this.actionError.set(
      describeMatrixRequestFailure(
        error,
        action === 'knock'
          ? 'Could not send the request. Try again.'
          : 'Could not join the room. Try again.',
      ).message,
    );
  }
}
