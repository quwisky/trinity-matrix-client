import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormField,
  FormRoot,
  form,
  submit,
  validate,
} from '@angular/forms/signals';
import { TrnButton, TrnInput, TrnLabel } from '@trinity/components/controls';
import {
  AvatarComponent,
  EmptyStateComponent,
} from '@trinity/components/generic-content';
import {
  TrnSettingsGroupComponent,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  IgnoredUsersService,
  type IgnoredUser,
} from '@trinity/data-access/identity';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { initialOf, isValidUserId } from '@trinity/util/matrix';
import { shownError } from '@trinity/util/ui';
import { catchError, finalize, firstValueFrom, map, of } from 'rxjs';

interface BlockFormModel {
  userId: string;
}

/** Settings › Privacy › Blocked users: the active account's ignore list, and adding to it. */
@Component({
  selector: 'trn-blocked-users',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './blocked-users.component.html',
  imports: [
    AvatarComponent,
    EmptyStateComponent,
    FormField,
    FormRoot,
    TrnButton,
    TrnInput,
    TrnLabel,
    TrnSettingsGroupComponent,
  ],
})
export class BlockedUsersComponent {
  private readonly ignoredUsers = inject(IgnoredUsersService);
  private readonly matrix = inject(MatrixClientService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly model = signal<BlockFormModel>({ userId: '' });

  protected readonly shownError = shownError;
  protected readonly users = this.ignoredUsers.ignoredUsers;
  protected readonly blocking = signal(false);
  protected readonly unblocking = signal<ReadonlySet<string>>(new Set());
  protected readonly description = computed(() => {
    const account = this.matrix.activeUserId();
    return this.matrix.accountIds().length > 1 && account
      ? `Blocks on ${account}: you won't see messages or invites from these people.`
      : "You won't see messages or invites from people you block.";
  });

  protected readonly blockForm = form(this.model, (path) => {
    validate(path.userId, ({ value }) => {
      const userId = value().trim();
      if (!isValidUserId(userId)) {
        return {
          kind: 'user-id-shape',
          message: 'Enter a full user ID, such as @name:example.org.',
        };
      }
      if (userId === this.matrix.activeUserId()) {
        return { kind: 'self', message: "You can't block yourself." };
      }
      if (this.users().some((user) => user.userId === userId)) {
        return {
          kind: 'already-blocked',
          message: `You've already blocked ${userId}.`,
        };
      }
      return undefined;
    });
  });

  constructor() {
    this.ignoredUsers
      .runProjection()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  protected nameOf(user: IgnoredUser): string {
    return user.displayName ?? user.userId;
  }

  protected initialFor(user: IgnoredUser): string {
    return initialOf(this.nameOf(user));
  }

  protected block(): void {
    if (this.blocking()) return;
    void submit(this.blockForm, {
      action: (field) => {
        const userId = field().value().userId.trim();
        this.blocking.set(true);
        // Signal Forms owns the Promise callback; the write stays a cold Observable.
        return firstValueFrom(
          this.ignoredUsers.ignore(userId).pipe(
            map(() => {
              this.blockForm().reset({ userId: '' });
              this.toast.show(`Blocked ${userId}.`, { duration: 2500 });
              return undefined;
            }),
            catchError(() => {
              this.toast.show(`Couldn't block ${userId}. Try again.`, {
                duration: 4000,
                variant: 'danger',
              });
              return of(undefined);
            }),
            finalize(() => this.blocking.set(false)),
            takeUntilDestroyed(this.destroyRef),
          ),
          { defaultValue: undefined },
        );
      },
    });
  }

  protected unblock(user: IgnoredUser): void {
    if (this.unblocking().has(user.userId)) return;
    const name = this.nameOf(user);
    this.setUnblocking(user.userId, true);
    this.ignoredUsers
      .unignore(user.userId)
      .pipe(
        finalize(() => this.setUnblocking(user.userId, false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => this.toast.show(`Unblocked ${name}.`, { duration: 5000 }),
        error: () =>
          this.toast.show(`Couldn't unblock ${name}. Try again.`, {
            duration: 4000,
            variant: 'danger',
          }),
      });
  }

  private setUnblocking(userId: string, on: boolean): void {
    this.unblocking.update((current) => {
      const next = new Set(current);
      if (on) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }
}
