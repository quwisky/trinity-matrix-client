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
import { TrnToastService } from '@trinity/helm/overlay';
import {
  KeywordRulesService,
  type KeywordRule,
} from '@trinity/data-access-notifications';

/**
 * The keyword list in Settings → Notifications: words that notify wherever they are said.
 *
 * Reads are synchronous snapshots off the synced push rules, and the service refreshes
 * that cache after every write — so the list is re-read after each operation rather than
 * patched optimistically. A keyword write is a create or a delete against the server, not
 * a flip, and showing a word that is not actually stored would be worse than a moment's
 * latency.
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
  readonly isEmpty = computed(() => this.keywordList().length === 0);

  /** True while an add is in flight. */
  readonly adding = signal(false);
  /** Keywords with a write in flight, so their row's controls disable. */
  private readonly busy = signal<ReadonlySet<string>>(new Set());

  /** The word being added. Signal Forms, like every other form in the workspace. */
  private readonly keywordModel = signal({ word: '' });
  readonly keywordForm = form(this.keywordModel);

  ngOnInit(): void {
    this.reload();
  }

  isBusy(pattern: string): boolean {
    return this.busy().has(pattern);
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
    const word = this.keywordModel().word.trim();
    if (!word) {
      return; // nothing typed; no need to scold
    }
    if (this.keywordsSvc.has(word)) {
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
        error: () => {
          this.adding.set(false);
          this.toast.show(`Could not add “${word}”.`, {
            duration: 4000,
            variant: 'destructive',
          });
        },
      });
  }

  /** Stop notifying on a keyword. */
  remove(pattern: string): void {
    this.setBusy(pattern, true);
    this.keywordsSvc
      .remove(pattern)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.setBusy(pattern, false);
          this.reload();
        },
        error: () => {
          this.setBusy(pattern, false);
          this.toast.show(`Could not remove “${pattern}”.`, {
            duration: 4000,
            variant: 'destructive',
          });
        },
      });
  }

  /** Turn a keyword's sound on or off. */
  toggleSound(pattern: string, sound: boolean): void {
    this.setBusy(pattern, true);
    this.keywordsSvc
      .setSound(pattern, sound)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.setBusy(pattern, false);
          this.reload();
        },
        error: () => {
          this.setBusy(pattern, false);
          this.reload(); // put the checkbox back where the server has it
          this.toast.show(`Could not update “${pattern}”.`, {
            duration: 4000,
            variant: 'destructive',
          });
        },
      });
  }

  private reload(): void {
    this.keywordList.set(this.keywordsSvc.keywords());
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
