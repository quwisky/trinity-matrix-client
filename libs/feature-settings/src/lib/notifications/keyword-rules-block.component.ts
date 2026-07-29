import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
  viewChildren,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormField, form } from '@angular/forms/signals';
import { HlmButton } from '@trinity/helm/button';
import { HlmCheckbox } from '@trinity/helm/checkbox';
import { HlmInput } from '@trinity/helm/input';
import { TrnToastService } from '@trinity/helm/overlay';
import {
  KeywordRulesService,
  KeywordValidationError,
  type KeywordRule,
} from '@trinity/data-access-notifications';

/**
 * The keyword list in Settings → Notifications: words that notify wherever they are said.
 *
 * Reads are synchronous snapshots off the synced push rules — the shape
 * {@link PushRulesService} and this section's toggles already use — and the service
 * re-reads them after every write, so the list is refreshed after each operation rather
 * than patched optimistically. A keyword write is a create or a delete against the server,
 * and showing a word that is not actually stored would be worse than a moment's latency.
 *
 * The one thing a refresh cannot fix is a rejected sound click: see {@link soundBoxes}.
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
   * The rows' sound checkboxes, in list order.
   *
   * `HlmCheckbox` flips itself on click and holds that in a `linkedSignal` over its
   * `checked` input, which only recomputes when the INPUT changes. So a rejected write
   * leaves the box showing one thing and the account holding another, and re-reading the
   * unchanged server value cannot fix it — the input never moved. Setting the control's
   * own signal back is the plainest way to say "put it back"; it is public and writable
   * for exactly this, being what a form's `writeValue` drives too.
   */
  private readonly soundBoxes = viewChildren(HlmCheckbox);

  /** The word being added. Signal Forms, like every other form in the workspace. */
  private readonly keywordModel = signal({ word: '' });
  readonly keywordForm = form(this.keywordModel);
  /** Nothing typed — the Add button has nothing to do. */
  readonly nothingTyped = computed(
    () => this.keywordForm.word().value().trim().length === 0,
  );

  ngOnInit(): void {
    this.reload();
  }

  isBusy(ruleId: string): boolean {
    return this.busy().has(ruleId);
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
    const word = this.keywordModel().word.trim();
    if (!word) {
      return; // nothing typed; no need to scold
    }
    const existing = this.keywordsSvc.find(word);
    // A keyword another client switched off is NOT a duplicate to refuse — re-adding it
    // is the only way to switch it back on, and refusing would leave it permanently inert.
    if (existing?.enabled) {
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
    this.keywordsSvc
      .setSound(keyword.ruleId, sound)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.setBusy(keyword.ruleId, false);
          this.reload();
        },
        error: () => {
          this.setBusy(keyword.ruleId, false);
          this.restoreSound(keyword);
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
    // Copied so the signal always changes identity: `@for` only re-diffs — and so only
    // re-evaluates the track keys — when the collection reference actually moves.
    this.keywordList.set([...this.keywordsSvc.keywords()]);
    this.loaded.set(this.keywordsSvc.hasLoaded());
  }

  /** Put a row's checkbox back to the sound setting the account actually holds. */
  private restoreSound(keyword: KeywordRule): void {
    const index = this.keywordList().findIndex(
      (candidate) => candidate.ruleId === keyword.ruleId,
    );
    this.soundBoxes()[index]?.checked.set(keyword.sound);
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
