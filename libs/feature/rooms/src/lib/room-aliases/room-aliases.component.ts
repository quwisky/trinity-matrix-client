import { RoomAliasesService } from '@trinity/data-access/room-administration';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormField, disabled, form } from '@angular/forms/signals';
import { TrnActionAvailability, TrnButton } from '@trinity/components/controls';
import { TrnInput } from '@trinity/components/controls';
import { TrnToastService } from '@trinity/components/overlay';
import { TrnTooltip } from '@trinity/components/generic-content';
import { RoomActionPermissionsService } from '@trinity/data-access/room-administration';

/** Reject alias localparts containing characters an `#alias:server` can't hold. */
const INVALID_LOCALPART = /[\s:#]/;

/**
 * Manage a room's published addresses: list its local aliases, add or remove them in the
 * homeserver directory, and choose the main (canonical) one. Rendered inside the room
 * settings dialog. The list stays readable after a live power-level change while each
 * mutation control becomes focusable-but-unavailable with an explanation. Backed by
 * {@link RoomAliasesService}; the synced client reflects canonical changes through state.
 */
@Component({
  selector: 'trn-room-aliases',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './room-aliases.component.html',
  imports: [FormField, TrnButton, TrnActionAvailability, TrnInput, TrnTooltip],
})
export class RoomAliasesComponent implements OnInit {
  readonly roomId = input.required<string>();

  private readonly aliasesSvc = inject(RoomAliasesService);
  private readonly permissions = inject(RoomActionPermissionsService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  /** The room's local aliases (`#…:server`), seeded on init. */
  readonly aliases = signal<readonly string[]>([]);
  /** The current main (canonical) alias, or null. */
  readonly canonical = signal<string | null>(null);
  /** True while an add is in flight. */
  readonly adding = signal(false);
  /** Aliases whose removal is in flight (disables their Remove button). */
  private readonly removing = signal<ReadonlySet<string>>(new Set());

  readonly serverName = this.aliasesSvc.serverName();
  readonly isEmpty = computed(() => this.aliases().length === 0);
  readonly availability = computed(
    () => this.permissions.settings(this.roomId()).aliases,
  );

  /** The new-alias localpart (the app prepends `#` and appends `:server`). */
  private readonly aliasModel = signal({ localpart: '' });
  readonly aliasForm = form(this.aliasModel, (path) => {
    disabled(path.localpart, { when: () => !this.availability().available });
  });

  ngOnInit(): void {
    this.canonical.set(this.aliasesSvc.currentCanonical(this.roomId()));
    this.aliasesSvc
      .localAliases(this.roomId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (aliases) => this.aliases.set(aliases),
        // A directory that can't be read shouldn't break the dialog; leave it empty.
        error: () => this.aliases.set([]),
      });
  }

  isRemoving(alias: string): boolean {
    return this.removing().has(alias);
  }

  /**
   * Enter in the address field adds the alias, and MUST swallow the event.
   *
   * This component is rendered inside the room/space settings `<form>`, which has a
   * `type="submit"` button — so a bare Enter in a text input implicitly submits that
   * form. Without this, typing an address and pressing Enter saves and CLOSES the
   * settings dialog without ever adding the alias, the opposite of what was asked.
   */
  onEnter(event: Event): void {
    event.preventDefault();
    this.add();
  }

  /** Publish `#<localpart>:<server>` as a new local alias. */
  add(): void {
    if (!this.availability().available) {
      return;
    }
    const localpart = this.aliasModel().localpart.trim().replace(/^#/, '');
    if (!this.serverName || !localpart || INVALID_LOCALPART.test(localpart)) {
      this.toast.show('Enter a valid address (letters, digits, no spaces).', {
        duration: 4000,
        variant: 'danger',
      });
      return;
    }
    const alias = `#${localpart}:${this.serverName}`;
    if (this.aliases().includes(alias)) {
      this.toast.show('That address already exists.', {
        duration: 3000,
        variant: 'danger',
      });
      return;
    }
    this.adding.set(true);
    this.aliasesSvc
      .addAlias(this.roomId(), alias)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.adding.set(false);
          this.aliases.update((list) => [...list, alias]);
          this.aliasForm().reset({ localpart: '' });
          this.toast.show(`Added ${alias}.`, {
            duration: 3000,
            variant: 'success',
          });
        },
        error: () => {
          this.adding.set(false);
          this.toast.show(`Could not add ${alias}.`, {
            duration: 4000,
            variant: 'danger',
          });
        },
      });
  }

  /** Remove a local alias; if it was the main one, the canonical clears too. */
  remove(alias: string): void {
    if (this.isRemoving(alias) || !this.availability().available) {
      return;
    }
    this.setRemoving(alias, true);
    this.aliasesSvc
      .removeAlias(this.roomId(), alias)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.setRemoving(alias, false);
          this.aliases.update((list) => list.filter((a) => a !== alias));
          if (this.canonical() === alias) {
            this.canonical.set(null);
          }
          this.toast.show(`Removed ${alias}.`, {
            duration: 3000,
            variant: 'success',
          });
        },
        error: () => {
          this.setRemoving(alias, false);
          this.toast.show(`Could not remove ${alias}.`, {
            duration: 4000,
            variant: 'danger',
          });
        },
      });
  }

  /** Make an existing local alias the room's main (canonical) address. */
  setMain(alias: string): void {
    if (!this.availability().available) {
      return;
    }
    this.aliasesSvc
      .setCanonicalAlias(this.roomId(), alias)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.canonical.set(alias);
          this.toast.show(`${alias} is now the main address.`, {
            duration: 3000,
            variant: 'success',
          });
        },
        error: () =>
          this.toast.show('Could not set the main address.', {
            duration: 4000,
            variant: 'danger',
          }),
      });
  }

  private setRemoving(alias: string, on: boolean): void {
    this.removing.update((set) => {
      const next = new Set(set);
      if (on) {
        next.add(alias);
      } else {
        next.delete(alias);
      }
      return next;
    });
  }
}
