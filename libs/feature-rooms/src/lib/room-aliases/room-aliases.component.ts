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
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { HlmButton } from '@trinity/helm/button';
import { HlmInput } from '@trinity/helm/input';
import { TrnToastService } from '@trinity/helm/overlay';
import { RoomAliasesService } from '@trinity/data-access-rooms';

/** Reject alias localparts containing characters an `#alias:server` can't hold. */
const INVALID_LOCALPART = /[\s:#]/;

/**
 * Manage a room's published addresses: list its local aliases, add or remove them in the
 * homeserver directory, and choose the main (canonical) one. Rendered inside the room
 * settings dialog for viewers whose power level lets them manage addresses. Backed by
 * {@link RoomAliasesService}; the synced client reflects canonical changes through state.
 */
@Component({
  selector: 'trn-room-aliases',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './room-aliases.component.html',
  imports: [ReactiveFormsModule, HlmButton, HlmInput],
})
export class RoomAliasesComponent implements OnInit {
  readonly roomId = input.required<string>();

  private readonly aliasesSvc = inject(RoomAliasesService);
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

  /** The new-alias localpart (the app prepends `#` and appends `:server`). */
  readonly newLocalpart = new FormControl('', { nonNullable: true });

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

  /** Publish `#<localpart>:<server>` as a new local alias. */
  add(): void {
    const localpart = this.newLocalpart.value.trim().replace(/^#/, '');
    if (!this.serverName || !localpart || INVALID_LOCALPART.test(localpart)) {
      this.toast.show('Enter a valid address (letters, digits, no spaces).', {
        duration: 4000,
        variant: 'destructive',
      });
      return;
    }
    const alias = `#${localpart}:${this.serverName}`;
    if (this.aliases().includes(alias)) {
      this.toast.show('That address already exists.', {
        duration: 3000,
        variant: 'destructive',
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
          this.newLocalpart.reset();
          this.toast.show(`Added ${alias}.`, {
            duration: 3000,
            variant: 'success',
          });
        },
        error: () => {
          this.adding.set(false);
          this.toast.show(`Could not add ${alias}.`, {
            duration: 4000,
            variant: 'destructive',
          });
        },
      });
  }

  /** Remove a local alias; if it was the main one, the canonical clears too. */
  remove(alias: string): void {
    if (this.isRemoving(alias)) {
      return;
    }
    this.setRemoving(alias, true);
    this.aliasesSvc
      .removeAlias(alias)
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
            variant: 'destructive',
          });
        },
      });
  }

  /** Make an existing local alias the room's main (canonical) address. */
  setMain(alias: string): void {
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
            variant: 'destructive',
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
