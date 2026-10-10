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
import {
  TrnSelectComponent,
  TrnSwitchComponent,
  type TrnSelectOption,
} from '@trinity/components/controls';
import {
  INSTALLATION_PREFERENCE_CONTEXT,
  PreferenceStoreService,
  type PreferenceCatalogEntry,
  type PreferenceCommandOutcome,
  type PreferenceContext,
  type PreferenceValue,
} from '@trinity/runtime/preferences';
import { finalize, take } from 'rxjs';
import { TrnSettingsRowComponent } from '@trinity/components/overlay';

@Component({
  selector: 'trn-preference-catalog-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  templateUrl: './preference-catalog-section.component.html',
  imports: [TrnSelectComponent, TrnSettingsRowComponent, TrnSwitchComponent],
})
export class PreferenceCatalogSectionComponent {
  private readonly store = inject(PreferenceStoreService);
  private readonly destroyRef = inject(DestroyRef);
  // Values shown while their save is in flight, so a controlled control does not snap back;
  // dropped when the save settles, leaving the store's value (the old one after a failure).
  private readonly pendingById = signal<ReadonlyMap<string, PreferenceValue>>(
    new Map(),
  );
  private readonly failureById = signal<ReadonlyMap<string, string>>(new Map());

  readonly section = input.required<string>();
  readonly context = input<PreferenceContext>(INSTALLATION_PREFERENCE_CONTEXT);
  readonly entries = computed(() =>
    this.store.entries(this.section(), this.context()),
  );

  /** Options per select entry, built once per catalog read so the select keeps one array. */
  readonly selectOptions = computed(() => {
    const byId = new Map<string, readonly TrnSelectOption<string>[]>();
    for (const entry of this.entries()) {
      if (entry.editor.kind !== 'select') continue;
      const testId = entry.editor.testId;
      byId.set(
        entry.id,
        entry.editor.options.map((option) => ({
          ...option,
          testId: `${testId}-${option.value}`,
        })),
      );
    }
    return byId;
  });

  checked(entry: PreferenceCatalogEntry): boolean {
    return (this.pendingById().get(entry.id) ?? entry.state().value) === true;
  }

  selected(entry: PreferenceCatalogEntry): string | null {
    const value = this.pendingById().get(entry.id) ?? entry.state().value;
    return typeof value === 'string' ? value : null;
  }

  busy(id: string): boolean {
    return this.pendingById().has(id);
  }

  failure(id: string): string | undefined {
    return this.failureById().get(id);
  }

  choose(
    entry: PreferenceCatalogEntry,
    value: string | null | undefined,
  ): void {
    if (value !== null && value !== undefined) this.update(entry, value);
  }

  update(entry: PreferenceCatalogEntry, value: PreferenceValue): void {
    if (this.busy(entry.id)) return;
    this.setPending(entry.id, value);
    this.clearFailure(entry.id);
    entry
      .set(value)
      .pipe(
        take(1),
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.setPending(entry.id, null)),
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

  private setPending(id: string, value: PreferenceValue | null): void {
    this.pendingById.update((current) => {
      const next = new Map(current);
      if (value === null) next.delete(id);
      else next.set(id, value);
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
