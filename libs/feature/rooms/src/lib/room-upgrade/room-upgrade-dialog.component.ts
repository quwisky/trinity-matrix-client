import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  linkedSignal,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormField, FormRoot, form } from '@angular/forms/signals';
import {
  TrnButton,
  TrnCheckboxComponent,
  TrnSelectComponent,
  type TrnSelectOption,
} from '@trinity/components/controls';
import {
  TrnDialogRef,
  TrnOverlaySurfaceDirective,
  TrnToastService,
  type ToastOptions,
} from '@trinity/components/overlay';
import {
  RoomAdministrationError,
  RoomUpgradeService,
  type RoomUpgradePlan,
  type RoomUpgradeResult,
  type RoomUpgradeTarget,
} from '@trinity/data-access/room-administration';

/** The version the dialog starts on: the server default when offered, else the highest. */
export function preselectedTarget(
  targets: readonly RoomUpgradeTarget[],
): string {
  return (targets.find((t) => t.isDefault) ?? targets.at(-1))?.version ?? '';
}

/** The toast after an upgrade: success, or what failed and what to retry. */
export function upgradeSummary(
  result: RoomUpgradeResult,
  spaceName: (spaceId: string) => string,
): { message: string; options: ToastOptions } {
  const { inviteFailed, relinkFailed } = result;
  if (inviteFailed.length === 0 && relinkFailed.length === 0) {
    return { message: 'Room upgraded.', options: { variant: 'success' } };
  }
  const counts = [
    count(inviteFailed.length, 'invite'),
    count(relinkFailed.length, 'space link'),
  ].filter((part): part is string => part !== null);
  const unlinked = relinkFailed
    .filter((failure) => !failure.linkedTwice)
    .map((failure) => spaceName(failure.spaceId));
  const twice = relinkFailed
    .filter((failure) => failure.linkedTwice)
    .map((failure) => spaceName(failure.spaceId));
  const retry = [
    inviteFailed.length
      ? `Invite again: ${list(inviteFailed.map((failure) => failure.userId))}.`
      : '',
    unlinked.length ? `Add the new room to: ${list(unlinked)}.` : '',
    twice.length ? `Remove the old room from: ${list(twice)}.` : '',
  ].filter(Boolean);
  return {
    message: [`Upgraded; ${counts.join(' and ')} failed.`, ...retry].join(' '),
    // Kept until dismissed: it is the only list of what still needs doing.
    options: { variant: 'warning', duration: 0 },
  };
}

/** Why the upgrade did not happen, for the dialog's inline error. */
export function upgradeErrorMessage(error: unknown): string {
  if (error instanceof RoomAdministrationError) {
    if (error.outcome.failure === 'permission-denied') {
      return 'You can no longer upgrade this room. Nothing was changed.';
    }
    if (error.outcome.failure === 'invalid-input') {
      return 'This room has already been upgraded. Nothing was changed.';
    }
  }
  const detail =
    error instanceof Error && error.message ? ` (${error.message})` : '';
  return `The server could not upgrade the room${detail}. Nothing was changed.`;
}

function count(n: number, noun: string): string | null {
  return n === 0 ? null : `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function list(items: readonly string[]): string {
  return new Intl.ListFormat('en', { type: 'conjunction' }).format(items);
}

/**
 * Upgrade one room to a newer room version. Runs the workflow itself, so it can finish and
 * report even if Room settings closes underneath; the opener's dismiss guard reads
 * {@link busy} to keep it open meanwhile. Closes with the result, or nothing on Cancel.
 */
@Component({
  selector: 'trn-room-upgrade-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormField,
    FormRoot,
    TrnButton,
    TrnCheckboxComponent,
    TrnOverlaySurfaceDirective,
    TrnSelectComponent,
  ],
  templateUrl: './room-upgrade-dialog.component.html',
})
export class RoomUpgradeDialogComponent {
  private readonly upgrades = inject(RoomUpgradeService);
  private readonly toast = inject(TrnToastService);
  private readonly dialogRef =
    inject<TrnDialogRef<RoomUpgradeResult>>(TrnDialogRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly model = linkedSignal(() => ({
    version: preselectedTarget(this.plan().targets),
    inviteMembers: this.plan().invitePrivateDefault,
  }));

  readonly accountId = input.required<string>();
  readonly roomId = input.required<string>();
  readonly plan = input.required<RoomUpgradePlan>();

  readonly upgradeForm = form(this.model);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly inviteMembers = computed(() => this.model().inviteMembers);
  readonly canUpgrade = computed(() => !!this.model().version && !this.busy());
  readonly versionOptions = computed<readonly TrnSelectOption<string>[]>(() =>
    this.plan().targets.map(({ version, isDefault }) => ({
      value: version,
      label: isDefault ? `${version} (server default)` : version,
      testId: `room-upgrade-version-${version}`,
    })),
  );

  setInviteMembers(checked: boolean): void {
    this.model.update((value) => ({ ...value, inviteMembers: checked }));
  }

  upgrade(): void {
    if (!this.canUpgrade()) return;
    const { version, inviteMembers } = this.model();
    this.busy.set(true);
    this.error.set(null);
    this.upgrades
      .upgrade(this.accountId(), this.roomId(), {
        version,
        // The checkbox is hidden with nobody to invite; never send its unseen default.
        inviteMembers: inviteMembers && this.plan().members.length > 0,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => {
          const { message, options } = upgradeSummary(
            result,
            (spaceId) =>
              this.plan().spaces.find((space) => space.spaceId === spaceId)
                ?.name ?? spaceId,
          );
          this.toast.show(message, options);
          this.dialogRef.close(result);
        },
        error: (error: unknown) => {
          this.busy.set(false);
          this.error.set(upgradeErrorMessage(error));
        },
      });
  }

  cancel(): void {
    if (!this.busy()) this.dialogRef.close();
  }
}
