import {
  RoomActionPermissionsService,
  RoomAdministrationError,
  RoomAliasesService,
  type RoomSettingsTarget,
} from '@trinity/data-access/room-administration';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnChanges,
  SimpleChanges,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormField, disabled, form } from '@angular/forms/signals';
import { TrnButton, TrnInput } from '@trinity/components/controls';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import { filter } from 'rxjs';

/** Reject alias localparts containing characters an `#alias:server` can't hold. */
const INVALID_LOCALPART = /[\s:#]/;

/**
 * Manage one Room or Space's published addresses inside its settings hub. The address
 * list, primary address and public copy/link actions stay readable after a live
 * power-level change while administration actions disappear with an explanation. Every
 * read and command stays pinned to the Account and target that opened settings.
 */
@Component({
  selector: 'trn-room-aliases',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './room-aliases.component.html',
  imports: [FormField, TrnButton, TrnInput],
})
export class RoomAliasesComponent implements OnChanges {
  private readonly aliasesSvc = inject(RoomAliasesService);
  private readonly permissions = inject(RoomActionPermissionsService);
  private readonly alert = inject(TrnAlertService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly removing = signal<ReadonlySet<string>>(new Set());
  private readonly confirmingRemoval = signal<ReadonlySet<string>>(new Set());
  private readonly aliasModel = signal({ localpart: '' });
  private targetGeneration = 0;
  private loadGeneration = 0;

  readonly accountId = input.required<string>();
  readonly roomId = input.required<string>();
  readonly noun = input<'Room' | 'Space'>('Room');
  readonly available = input(true);
  readonly aliases = signal<readonly string[]>([]);
  readonly canonical = signal<string | null>(null);
  readonly loading = signal(true);
  readonly loadFailed = signal(false);
  readonly adding = signal(false);
  readonly settingPrimary = signal<string | null>(null);
  readonly target = computed<RoomSettingsTarget>(() => ({
    accountId: this.accountId(),
    roomId: this.roomId(),
  }));
  readonly serverName = computed(() =>
    this.aliasesSvc.serverName(this.target()),
  );
  readonly hasNoLocalAddresses = computed(() => this.aliases().length === 0);
  readonly canonicalIsLocal = computed(() => {
    const canonical = this.canonical();
    return canonical !== null && this.aliases().includes(canonical);
  });
  readonly availability = computed(() =>
    this.available()
      ? this.permissions.settingsFor(this.target()).aliases
      : { available: false, reason: null },
  );
  readonly restrictionReason = computed(() =>
    this.noun() === 'Space'
      ? "The opening Account cannot currently manage this Space's addresses."
      : this.availability().reason,
  );
  readonly aliasForm = form(this.aliasModel, (path) => {
    disabled(path.localpart, {
      when: () => !this.availability().available || this.adding(),
    });
  });

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['accountId'] && !changes['roomId']) {
      if (changes['available'] && this.available()) this.load();
      return;
    }
    this.targetGeneration += 1;
    this.loadGeneration += 1;
    this.adding.set(false);
    this.settingPrimary.set(null);
    this.removing.set(new Set());
    this.confirmingRemoval.set(new Set());
    this.aliasForm().reset({ localpart: '' });
    this.load();
  }

  /** Reload the homeserver directory for this immutable settings target. */
  load(): void {
    if (!this.available()) {
      this.loading.set(false);
      return;
    }
    const target = this.target();
    const targetGeneration = this.targetGeneration;
    const loadGeneration = ++this.loadGeneration;
    this.loading.set(true);
    this.loadFailed.set(false);
    this.aliases.set([]);
    this.canonical.set(this.aliasesSvc.currentCanonical(target));
    this.aliasesSvc
      .localAliases(target)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (aliases) => {
          if (
            !this.isCurrent(target, targetGeneration) ||
            loadGeneration !== this.loadGeneration
          ) {
            return;
          }
          this.aliases.set(aliases);
          this.loading.set(false);
        },
        error: () => {
          if (
            !this.isCurrent(target, targetGeneration) ||
            loadGeneration !== this.loadGeneration
          ) {
            return;
          }
          this.loading.set(false);
          this.loadFailed.set(true);
        },
      });
  }

  isRemoving(alias: string): boolean {
    return this.removing().has(alias);
  }

  isConfirmingRemoval(alias: string): boolean {
    return this.confirmingRemoval().has(alias);
  }

  /** Swallow Enter so the enclosing settings form cannot treat this as a global Save. */
  onEnter(event: Event): void {
    event.preventDefault();
    this.add();
  }

  /** Publish `#<localpart>:<server>` as a new local alias. */
  add(): void {
    if (!this.availability().available || this.adding()) return;
    const target = this.target();
    const generation = this.targetGeneration;
    const serverName = this.serverName();
    const localpart = this.aliasModel().localpart.trim().replace(/^#/, '');
    if (!serverName || !localpart || INVALID_LOCALPART.test(localpart)) {
      this.toast.show('Enter a valid address (letters, digits, no spaces).', {
        duration: 4000,
        variant: 'danger',
      });
      return;
    }
    const alias = `#${localpart}:${serverName}`;
    if (this.aliases().includes(alias)) {
      this.toast.show('That address already exists.', {
        duration: 3000,
        variant: 'danger',
      });
      return;
    }
    this.adding.set(true);
    this.aliasesSvc
      .addAlias(target, alias)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          if (!this.isCurrent(target, generation)) return;
          this.adding.set(false);
          this.aliases.update((list) => [...list, alias]);
          this.aliasForm().reset({ localpart: '' });
          this.toast.show(`Added ${alias}.`, {
            duration: 3000,
            variant: 'success',
          });
        },
        error: () => {
          if (!this.isCurrent(target, generation)) return;
          this.adding.set(false);
          this.toast.show(`Could not add ${alias}.`, {
            duration: 4000,
            variant: 'danger',
          });
        },
      });
  }

  /** Confirm the exact joining/linking effect before removing one local alias. */
  remove(alias: string): void {
    if (
      this.isRemoving(alias) ||
      this.isConfirmingRemoval(alias) ||
      !this.availability().available
    ) {
      return;
    }
    const target = this.target();
    const generation = this.targetGeneration;
    this.setConfirmingRemoval(alias, true);
    this.alert
      .confirm$({
        header: `Remove ${alias}?`,
        message: `People will no longer be able to join or link to this ${this.noun().toLowerCase()} with ${alias}. This does not delete the ${this.noun()}.`,
        confirmText: 'Remove address',
        cancelText: 'Keep address',
        variant: 'danger',
        closeOnNavigation: false,
      })
      .pipe(
        filter((confirmed) => confirmed),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.setConfirmingRemoval(alias, false);
          // Confirmation is an async boundary: re-check target, membership and authority.
          if (
            !this.isCurrent(target, generation) ||
            !this.availability().available ||
            !this.aliases().includes(alias)
          ) {
            return;
          }
          this.runRemove(target, generation, alias);
        },
        complete: () => this.setConfirmingRemoval(alias, false),
      });
  }

  /** Make an existing local alias the target's primary (canonical) address. */
  setPrimary(alias: string): void {
    if (!this.availability().available || this.settingPrimary()) return;
    const target = this.target();
    const generation = this.targetGeneration;
    this.settingPrimary.set(alias);
    this.aliasesSvc
      .setCanonicalAlias(target, alias)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          if (!this.isCurrent(target, generation)) return;
          this.settingPrimary.set(null);
          this.canonical.set(alias);
          this.toast.show(`${alias} is now the primary address.`, {
            duration: 3000,
            variant: 'success',
          });
        },
        error: () => {
          if (!this.isCurrent(target, generation)) return;
          this.settingPrimary.set(null);
          this.toast.show(`Could not make ${alias} the primary address.`, {
            duration: 4000,
            variant: 'danger',
          });
        },
      });
  }

  matrixToUrl(alias: string): string {
    return `https://matrix.to/#/${encodeURIComponent(alias)}`;
  }

  /** Copy an address, selecting its full wrapped value when the Clipboard API fails. */
  copy(alias: string, address: HTMLElement): void {
    let write: Promise<void>;
    try {
      write =
        typeof navigator.clipboard?.writeText === 'function'
          ? navigator.clipboard.writeText(alias)
          : Promise.reject(new Error('Clipboard API unavailable'));
    } catch (error) {
      write = Promise.reject(error);
    }
    void write.then(
      () => this.toast.show('Address copied.', { duration: 2000 }),
      () => {
        this.selectAddress(address);
        this.toast.show(
          'Could not copy the address. It is selected above; copy it manually.',
          { duration: 5000, variant: 'danger' },
        );
      },
    );
  }

  private runRemove(
    target: RoomSettingsTarget,
    generation: number,
    alias: string,
  ): void {
    this.setRemoving(alias, true);
    this.aliasesSvc
      .removeAlias(target, alias)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          if (!this.isCurrent(target, generation)) return;
          this.setRemoving(alias, false);
          this.aliases.update((list) => list.filter((item) => item !== alias));
          if (this.canonical() === alias) this.canonical.set(null);
          this.toast.show(`Removed ${alias}.`, {
            duration: 3000,
            variant: 'success',
          });
        },
        error: (error: unknown) => {
          if (!this.isCurrent(target, generation)) return;
          this.setRemoving(alias, false);
          const primaryCleared =
            error instanceof RoomAdministrationError &&
            error.outcome.completedStep === 'canonical-address-cleared';
          if (primaryCleared) this.canonical.set(null);
          this.toast.show(
            primaryCleared
              ? `The primary address was cleared, but ${alias} could not be removed.`
              : `Could not remove ${alias}.`,
            { duration: 4000, variant: 'danger' },
          );
        },
      });
  }

  private selectAddress(address: HTMLElement): void {
    const selection = address.ownerDocument.getSelection();
    if (!selection) return;
    address.focus();
    const range = address.ownerDocument.createRange();
    range.selectNodeContents(address);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  private setRemoving(alias: string, on: boolean): void {
    this.removing.update((set) => this.toggleSetValue(set, alias, on));
  }

  private setConfirmingRemoval(alias: string, on: boolean): void {
    this.confirmingRemoval.update((set) => this.toggleSetValue(set, alias, on));
  }

  private toggleSetValue(
    set: ReadonlySet<string>,
    value: string,
    on: boolean,
  ): ReadonlySet<string> {
    const next = new Set(set);
    if (on) next.add(value);
    else next.delete(value);
    return next;
  }

  private isCurrent(target: RoomSettingsTarget, generation: number): boolean {
    return (
      generation === this.targetGeneration &&
      this.accountId() === target.accountId &&
      this.roomId() === target.roomId
    );
  }
}
