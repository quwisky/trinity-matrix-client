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

const SAVE_FAILED_MESSAGE = 'This preference could not be saved. Try again.';

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

  /**
   * Saves a choice made in `control`. A select's `value` is a `model()` that already holds the
   * choice by the time this runs, and a save that fails synchronously drops the pending value
   * within the same tick, so the `[value]` binding never changes and cannot undo it. After any
   * failure the stored value is therefore pushed back into the control itself.
   */
  choose(
    entry: PreferenceCatalogEntry,
    value: string | null | undefined,
    control: TrnSelectComponent<string>,
  ): void {
    if (value === null || value === undefined) return;
    // Resetting the control below emits its own change; the stored value needs no save.
    if (value === entry.state().value) return;
    this.update(entry, value, () => control.value.set(this.selected(entry)));
  }

  update(
    entry: PreferenceCatalogEntry,
    value: PreferenceValue,
    restore?: () => void,
  ): void {
    if (this.busy(entry.id)) return;
    let failed = false;
    const fail = (message: string): void => {
      failed = true;
      this.setFailure(entry.id, message);
    };
    this.setPending(entry.id, value);
    this.clearFailure(entry.id);
    entry
      .set(value)
      .pipe(
        take(1),
        takeUntilDestroyed(this.destroyRef),
        finalize(() => {
          this.setPending(entry.id, null);
          if (failed) restore?.();
        }),
      )
      .subscribe({
        next: (outcome) => {
          const message = this.failureMessage(outcome);
          if (message !== null) fail(message);
        },
        error: () => fail(SAVE_FAILED_MESSAGE),
      });
  }

  private failureMessage(outcome: PreferenceCommandOutcome): string | null {
    if (outcome.kind === 'completed') return null;
    if (outcome.recovery === 'fix-value') return 'This value is not accepted.';
    if (outcome.recovery === 'select-matching-scope') {
      return 'This preference is unavailable in the selected scope.';
    }
    return SAVE_FAILED_MESSAGE;
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
