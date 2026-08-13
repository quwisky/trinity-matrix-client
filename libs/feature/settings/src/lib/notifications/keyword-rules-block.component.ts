import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormField, form } from '@angular/forms/signals';
import { HlmButton } from '@trinity/helm/button';
import { HlmCheckbox } from '@trinity/helm/checkbox';
import { HlmInput } from '@trinity/helm/input';
import { TrnToastService } from '@trinity/components/overlay';
import {
  KeywordRulesService,
  KeywordValidationError,
  type KeywordRule,
} from '@trinity/data-access/notifications';

/**
 * The keyword list in Settings → Notifications: words that notify wherever they are said.
 *
 * Reads are synchronous snapshots off the synced push rules — the shape
 * {@link PushRulesService} and this section's toggles already use — and the service
 * re-reads them after every write, so the list is refreshed after each operation rather
 * than patched optimistically. A keyword write is a create or a delete against the server,
 * and showing a word that is not actually stored would be worse than a moment's latency.
 *
 * A pending sound change is held optimistically: see {@link optimisticSound}.
 */
@Component({
  selector: 'trn-keyword-rules',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './keyword-rules-block.component.html',
  imports: [FormField, HlmButton, HlmCheckbox, HlmInput],
})
export class KeywordRulesBlockComponent implements OnInit {
  private readonly keywordsSvc = inject(KeywordRulesService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly keywordList = signal<readonly KeywordRule[]>([]);
  readonly keywords = this.keywordList.asReadonly();

  /**
   * Whether the account's rules have synced. "You have no keywords yet" is a positive
   * claim, and before the first sync it is one we cannot make — the list is empty because
   * nothing has arrived, not because the account holds none.
   */
  private readonly loaded = signal(false);
  readonly isEmpty = computed(
    () => this.loaded() && this.keywordList().length === 0,
  );
  readonly isLoading = computed(() => !this.loaded());

  /** True while an add is in flight; also the re-entrancy guard for {@link add}. */
  readonly adding = signal(false);
  /** Keywords with a write in flight, so their row's controls disable. */
  private readonly busy = signal<ReadonlySet<string>>(new Set());
  /**
   * Sound states shown ahead of the server, keyed by rule id — the same optimistic shape
   * the section's own toggles use (see NotificationsSectionComponent).
   *
   * `HlmCheckbox` flips itself on click and holds that in a `linkedSignal` over its
   * `checked` input, which only recomputes when the INPUT changes. Binding the input to
   * this map means a rejected write moves it back to the server's value, which IS a
   * transition, so the control resyncs — without reaching into Helm internals or relying
   * on a row's position, which any extra checkbox in this template would shift.
   */
  private readonly optimisticSound = signal<ReadonlyMap<string, boolean>>(
    new Map(),
  );

  /** The word being added. Signal Forms, like every other form in the workspace. */
  private readonly keywordModel = signal({ word: '' });
  readonly keywordForm = form(this.keywordModel);
  /** The trimmed word in the field. One accessor, so the button and the write agree. */
  private readonly typedWord = (): string =>
    this.keywordForm.word().value().trim();
  /** Nothing typed — the Add button has nothing to do. */
  readonly nothingTyped = computed(() => this.typedWord().length === 0);

  ngOnInit(): void {
    this.reload();
  }

  isBusy(ruleId: string): boolean {
    return this.busy().has(ruleId);
  }

  /** What the row's Sound box should show: the pending value, else the server's. */
  soundOf(keyword: KeywordRule): boolean {
    return this.optimisticSound().get(keyword.ruleId) ?? keyword.sound;
  }

  /**
   * Enter in the field adds the keyword. `preventDefault` is defensive rather than
   * required — this block sits in no `<form>` today — but a bare Enter inside one submits
   * it, and settings sections get moved.
   */
  onEnter(event: Event): void {
    event.preventDefault();
    this.add();
  }

  /** Add the typed word as a keyword. */
  add(): void {
    if (this.adding()) {
      return; // Enter pressed twice would otherwise race two identical writes
    }
    const word = this.typedWord();
    if (!word) {
      return; // nothing typed; no need to scold
    }
    const existing = this.keywordsSvc.find(word);
    // Refuse only an exact repeat. A keyword another client switched off must be
    // re-addable — that is the only way to switch it back on — and so must a different
    // spelling of one, which the service re-points rather than duplicating; refusing that
    // leaves someone unable to fix the casing of their own keyword except by removing it.
    if (existing?.enabled && existing.pattern === word) {
      this.toast.show(`“${word}” is already in your keywords.`, {
        duration: 3000,
        variant: 'destructive',
      });
      return;
    }
    this.adding.set(true);
    this.keywordsSvc
      .add(word)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.adding.set(false);
          this.keywordForm().reset({ word: '' });
          this.reload();
        },
        error: (error: unknown) => {
          this.adding.set(false);
          // The write may have half-applied — the rule created, the enable or the re-read
          // failed — so re-read rather than assume the list is unchanged.
          this.reload();
          this.toast.show(this.messageFor(error, `Could not add “${word}”.`), {
            duration: 4000,
            variant: 'destructive',
          });
        },
      });
  }

  /** Stop notifying on a keyword. */
  remove(keyword: KeywordRule): void {
    this.setBusy(keyword.ruleId, true);
    this.keywordsSvc
      .remove(keyword.ruleId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.setBusy(keyword.ruleId, false);
          this.reload();
        },
        error: () => {
          this.setBusy(keyword.ruleId, false);
          this.reload();
          this.toast.show(`Could not remove “${keyword.pattern}”.`, {
            duration: 4000,
            variant: 'destructive',
          });
        },
      });
  }

  /** Turn a keyword's sound on or off. */
  toggleSound(keyword: KeywordRule, sound: boolean): void {
    this.setBusy(keyword.ruleId, true);
    this.setOptimisticSound(keyword.ruleId, sound);
    this.keywordsSvc
      .setSound(keyword.ruleId, sound)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.setBusy(keyword.ruleId, false);
          this.reload();
          this.clearOptimisticSound(keyword.ruleId);
        },
        error: () => {
          this.setBusy(keyword.ruleId, false);
          // Back to the server's value, and re-read: the write may have landed and only
          // the response been lost, the same reasoning add and remove are written around.
          this.setOptimisticSound(keyword.ruleId, keyword.sound);
          this.reload();
          this.toast.show(`Could not update “${keyword.pattern}”.`, {
            duration: 4000,
            variant: 'destructive',
          });
        },
      });
  }

  /**
   * Repeat the service's own words only when they were written for the user — a rejected
   * glob explains itself; the raw text of a 429 does not.
   */
  private messageFor(error: unknown, fallback: string): string {
    return error instanceof KeywordValidationError ? error.message : fallback;
  }

  private reload(): void {
    this.keywordList.set(this.keywordsSvc.keywords());
    this.loaded.set(this.keywordsSvc.hasLoaded());
  }

  private setOptimisticSound(ruleId: string, sound: boolean): void {
    this.optimisticSound.update((current) =>
      new Map(current).set(ruleId, sound),
    );
  }

  private clearOptimisticSound(ruleId: string): void {
    this.optimisticSound.update((current) => {
      const next = new Map(current);
      next.delete(ruleId);
      return next;
    });
  }

  private setBusy(ruleId: string, on: boolean): void {
    this.busy.update((current) => {
      const next = new Set(current);
      if (on) {
        next.add(ruleId);
      } else {
        next.delete(ruleId);
      }
      return next;
    });
  }
}
