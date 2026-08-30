import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnSwitchComponent } from '@trinity/components/switch';
import {
  INSTALLATION_PREFERENCE_CONTEXT,
  PreferenceStoreService,
  type PreferenceCatalogEntry,
  type PreferenceCommandOutcome,
  type PreferenceContext,
} from '@trinity/runtime/preferences';
import { finalize, take } from 'rxjs';
import { SettingsToggleRowDirective } from '../settings-toggle-row.directive';

@Component({
  selector: 'trn-preference-catalog-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './preference-catalog-section.component.html',
  imports: [TrnSwitchComponent, SettingsToggleRowDirective],
})
export class PreferenceCatalogSectionComponent {
  private readonly store = inject(PreferenceStoreService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly busyIds = signal<ReadonlySet<string>>(new Set());
  private readonly failureById = signal<ReadonlyMap<string, string>>(new Map());

  readonly section = input.required<string>();
  readonly context = input<PreferenceContext>(INSTALLATION_PREFERENCE_CONTEXT);
  readonly entries = computed(() =>
    this.store.entries(this.section(), this.context()),
  );

  checked(entry: PreferenceCatalogEntry): boolean {
    return entry.state().value === true;
  }

  busy(id: string): boolean {
    return this.busyIds().has(id);
  }

  failure(id: string): string | undefined {
    return this.failureById().get(id);
  }

  update(entry: PreferenceCatalogEntry, value: boolean): void {
    if (this.busy(entry.id)) return;
    this.setBusy(entry.id, true);
    this.clearFailure(entry.id);
    entry
      .set(value)
      .pipe(
        take(1),
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.setBusy(entry.id, false)),
      )
      .subscribe({
        next: (outcome) => this.handleOutcome(entry.id, outcome),
        error: () =>
          this.setFailure(
            entry.id,
            'This preference could not be saved. Try again.',
          ),
      });
  }

  private handleOutcome(id: string, outcome: PreferenceCommandOutcome): void {
    if (outcome.kind === 'completed') return;
    const message =
      outcome.recovery === 'fix-value'
        ? 'This value is not accepted.'
        : outcome.recovery === 'select-matching-scope'
          ? 'This preference is unavailable in the selected scope.'
          : 'This preference could not be saved. Try again.';
    this.setFailure(id, message);
  }

  private setBusy(id: string, busy: boolean): void {
    this.busyIds.update((current) => {
      const next = new Set(current);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  private clearFailure(id: string): void {
    this.failureById.update((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }

  private setFailure(id: string, message: string): void {
    this.failureById.update((current) => {
      const next = new Map(current);
      next.set(id, message);
      return next;
    });
  }
}
