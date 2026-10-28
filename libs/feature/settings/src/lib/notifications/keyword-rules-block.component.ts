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
import { TrnButton } from '@trinity/components/controls';
import { TrnInput } from '@trinity/components/controls';
import {
  KeywordRulesService,
  KeywordValidationError,
  type KeywordRule,
} from '@trinity/data-access/notifications';
import {
  TrnSettingsGroupComponent,
  TrnSettingsRowComponent,
  TrnToastService,
} from '@trinity/components/overlay';
import { EmptyStateComponent } from '@trinity/components/generic-content';

/**
 * The keyword list in Settings → Notifications: words that notify wherever they are said.
 *
 * Reads are synchronous snapshots off the synced push rules, re-read after every write rather
 * than patched optimistically: a keyword write is a create or delete against the server, and
 * showing a word that is not stored is worse than a moment's latency.
 */
@Component({
  selector: 'trn-keyword-rules',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './keyword-rules-block.component.html',
  imports: [
    EmptyStateComponent,
    TrnSettingsRowComponent,
    TrnSettingsGroupComponent,
    FormField,
    TrnButton,
    TrnInput,
  ],
})
export class KeywordRulesBlockComponent implements OnInit {
  private readonly keywordsSvc = inject(KeywordRulesService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly keywordList = signal<readonly KeywordRule[]>([]);
  readonly keywords = this.keywordList.asReadonly();

  /**
   * Whether the account's rules have synced. "No keywords yet" is a claim we cannot make
   * before the first sync: the list is empty because nothing has arrived.
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

  /** The word being added. */
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

  isBusy(pattern: string): boolean {
    return this.busy().has(pattern);
  }

  /**
   * Enter in the field adds the keyword. `preventDefault` is defensive: this block sits in no
   * `<form>` today, but a bare Enter inside one submits it.
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
    // Refuse only an exact repeat: a keyword another client switched off must be re-addable
    // (the only way to switch it on), and so must a different spelling, which the service
    // re-points rather than duplicates.
    if (existing?.enabled && existing.pattern === word) {
      this.toast.show(`“${word}” is already in your keywords.`, {
        duration: 3000,
        variant: 'danger',
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
            variant: 'danger',
          });
        },
      });
  }

  /** Stop notifying on a keyword. */
  remove(keyword: KeywordRule): void {
    this.setBusy(keyword.pattern, true);
    this.keywordsSvc
      .remove(keyword.pattern)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.setBusy(keyword.pattern, false);
          this.reload();
        },
        error: () => {
          this.setBusy(keyword.pattern, false);
          this.reload();
          this.toast.show(`Could not remove “${keyword.pattern}”.`, {
            duration: 4000,
            variant: 'danger',
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

  private setBusy(pattern: string, on: boolean): void {
    this.busy.update((current) => {
      const next = new Set(current);
      if (on) {
        next.add(pattern);
      } else {
        next.delete(pattern);
      }
      return next;
    });
  }
}
