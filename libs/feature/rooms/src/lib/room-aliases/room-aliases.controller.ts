import {
  RoomActionPermissionsService,
  RoomAdministrationError,
  RoomAliasesService,
  type RoomSettingsTarget,
} from '@trinity/data-access/room-administration';
import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
  type Signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { disabled, form } from '@angular/forms/signals';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import { type LatestToken, latestGuard } from '@trinity/util/ui';
import { Subject, catchError, filter, map, of, switchMap } from 'rxjs';

/** Reject alias localparts containing characters an `#alias:server` can't hold. */
const INVALID_LOCALPART = /[\s:#]/;

/** The host component's inputs, which the controller reads live. */
export interface RoomAliasesSource {
  readonly accountId: Signal<string>;
  readonly roomId: Signal<string>;
  readonly noun: Signal<'Room' | 'Space'>;
  readonly available: Signal<boolean>;
}

/**
 * The load, add, remove and set-primary workflow of one Room or Space's addresses. Provided
 * by the aliases component, so it lives and dies with one settings hub; every read and
 * command stays pinned to the Account and target that opened settings.
 */
@Injectable()
export class RoomAliasesController {
  private readonly aliasesSvc = inject(RoomAliasesService);
  private readonly permissions = inject(RoomActionPermissionsService);
  private readonly alert = inject(TrnAlertService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly removing = signal<ReadonlySet<string>>(new Set());
  private readonly confirmingRemoval = signal<ReadonlySet<string>>(new Set());
  /** Set by {@link connect}, which must run before the controller is used. */
  private source!: RoomAliasesSource;
  private readonly aliasModel = signal({ localpart: '' });
  private readonly targetSwitch = latestGuard();
  private targetToken = this.targetSwitch.next();
  /** A newer directory load cancels the one still in flight. */
  private readonly loads = new Subject<{
    readonly target: RoomSettingsTarget;
    readonly token: LatestToken;
  }>();

  readonly aliases = signal<readonly string[]>([]);
  readonly canonical = signal<string | null>(null);
  readonly loading = signal(true);
  readonly loadFailed = signal(false);
  readonly adding = signal(false);
  readonly settingPrimary = signal<string | null>(null);
  readonly target = computed<RoomSettingsTarget>(() => ({
    accountId: this.source.accountId(),
    roomId: this.source.roomId(),
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
    this.source.available()
      ? this.permissions.settingsFor(this.target()).aliases
      : { available: false, reason: null },
  );
  readonly restrictionReason = computed(() =>
    this.source.noun() === 'Space'
      ? "This account cannot currently manage this space's addresses."
      : this.availability().reason,
  );
  readonly aliasForm = form(this.aliasModel, (path) => {
    disabled(path.localpart, {
      when: () => !this.availability().available || this.adding(),
    });
  });

  constructor() {
    this.loads
      .pipe(
        switchMap(({ target, token }) =>
          this.aliasesSvc.localAliases(target).pipe(
            map((aliases) => ({ target, token, aliases })),
            catchError(() => of({ target, token, aliases: null })),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(({ target, token, aliases }) => {
        if (!this.isCurrent(target, token)) return;
        this.loading.set(false);
        if (aliases) this.aliases.set(aliases);
        else this.loadFailed.set(true);
      });
  }

  /** Bind the host's inputs. Call before any other member; the host's constructor does. */
  connect(source: RoomAliasesSource): void {
    this.source = source;
  }

  /** The opening target changed: forget every in-flight command and the typed address. */
  switchTarget(): void {
    this.targetToken = this.targetSwitch.next();
    this.adding.set(false);
    this.settingPrimary.set(null);
    this.removing.set(new Set());
    this.confirmingRemoval.set(new Set());
    this.aliasForm().reset({ localpart: '' });
  }

  /** Reload the homeserver directory for this immutable settings target. */
  load(): void {
    if (!this.source.available()) {
      this.loading.set(false);
      return;
    }
    const target = this.target();
    this.loading.set(true);
    this.loadFailed.set(false);
    this.aliases.set([]);
    this.canonical.set(this.aliasesSvc.currentCanonical(target));
    this.loads.next({ target, token: this.targetToken });
  }

  isRemoving(alias: string): boolean {
    return this.removing().has(alias);
  }

  isConfirmingRemoval(alias: string): boolean {
    return this.confirmingRemoval().has(alias);
  }

  /** Publish `#<localpart>:<server>` as a new local alias. */
  add(): void {
    if (!this.availability().available || this.adding()) return;
    const target = this.target();
    const token = this.targetToken;
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
          if (!this.isCurrent(target, token)) return;
          this.adding.set(false);
          this.aliases.update((list) => [...list, alias]);
          this.aliasForm().reset({ localpart: '' });
          this.toast.show(`Added ${alias}.`, {
            duration: 3000,
            variant: 'success',
          });
        },
        error: () => {
          if (!this.isCurrent(target, token)) return;
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
    const token = this.targetToken;
    this.setConfirmingRemoval(alias, true);
    this.alert
      .confirm$({
        header: `Remove ${alias}?`,
        message: `People will no longer be able to join or link to this ${this.source.noun().toLowerCase()} with ${alias}. This does not delete the ${this.source.noun().toLowerCase()}.`,
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
            !this.isCurrent(target, token) ||
            !this.availability().available ||
            !this.aliases().includes(alias)
          ) {
            return;
          }
          this.runRemove(target, token, alias);
        },
        complete: () => this.setConfirmingRemoval(alias, false),
      });
  }

  /** Make an existing local alias the target's primary (canonical) address. */
  setPrimary(alias: string): void {
    if (!this.availability().available || this.settingPrimary()) return;
    const target = this.target();
    const token = this.targetToken;
    this.settingPrimary.set(alias);
    this.aliasesSvc
      .setCanonicalAlias(target, alias)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          if (!this.isCurrent(target, token)) return;
          this.settingPrimary.set(null);
          this.canonical.set(alias);
          this.toast.show(`${alias} is now the primary address.`, {
            duration: 3000,
            variant: 'success',
          });
        },
        error: () => {
          if (!this.isCurrent(target, token)) return;
          this.settingPrimary.set(null);
          this.toast.show(`Could not make ${alias} the primary address.`, {
            duration: 4000,
            variant: 'danger',
          });
        },
      });
  }

  private runRemove(
    target: RoomSettingsTarget,
    token: LatestToken,
    alias: string,
  ): void {
    this.setRemoving(alias, true);
    this.aliasesSvc
      .removeAlias(target, alias)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          if (!this.isCurrent(target, token)) return;
          this.setRemoving(alias, false);
          this.aliases.update((list) => list.filter((item) => item !== alias));
          if (this.canonical() === alias) this.canonical.set(null);
          this.toast.show(`Removed ${alias}.`, {
            duration: 3000,
            variant: 'success',
          });
        },
        error: (error: unknown) => {
          if (!this.isCurrent(target, token)) return;
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

  private isCurrent(target: RoomSettingsTarget, token: LatestToken): boolean {
    return (
      this.targetSwitch.isCurrent(token) &&
      this.source.accountId() === target.accountId &&
      this.source.roomId() === target.roomId
    );
  }
}
