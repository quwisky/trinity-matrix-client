import {
  afterNextRender,
  effect,
  untracked,
  type ElementRef,
  type Injector,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import {
  applyFormat,
  continueList,
  type EditResult,
  type FormatAction,
} from '@trinity/util/matrix';

interface FormatSelection {
  readonly context: object;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Which formatting action each shortcut applies. An explicit table rather than deriving the
 * action from the id: a `format.*` id with no entry here is simply not a formatting shortcut,
 * where slicing the prefix off would have produced a bogus action and applied nothing.
 */
const SHORTCUT_ACTIONS: Readonly<Record<string, FormatAction>> = {
  'format.bold': 'bold',
  'format.italic': 'italic',
  'format.strike': 'strike',
  'format.code': 'code',
  'format.link': 'link',
};

/** What the formatting needs from the composer around it. */
export interface ComposerFormattingPorts {
  readonly text: WritableSignal<string>;
  /** Whether the preview is showing in place of the input. */
  readonly previewing: WritableSignal<boolean>;
  /** An IME composition is in progress. */
  readonly composing: Signal<boolean>;
  readonly editing: Signal<boolean>;
  /** Changes whenever the Account, Conversation or editing target does. */
  readonly context: Signal<object>;
  readonly textarea: Signal<ElementRef<HTMLTextAreaElement> | undefined>;
  readonly previewPanel: Signal<ElementRef<HTMLElement> | undefined>;
  /** Resolves the user's (rebindable) chords. */
  readonly shortcuts: { resolve(event: KeyboardEvent): { id: string } | null };
  /** Land an edit in the field. */
  readonly write: (result: EditResult) => void;
  readonly autoGrow: () => void;
  /** Re-read the autocomplete triggers after a caret move. */
  readonly syncMenus: () => void;
  /** Announce whether there is anything to send. */
  readonly typing: (hasText: boolean) => void;
}

/**
 * Formatting chords, list continuation, quoting, the format menu's saved selection and the
 * preview toggle — everything that rewrites the box on purpose rather than by typing.
 * A plain class, like the other composer controllers.
 */
export class ComposerFormatting {
  private selection: FormatSelection | null = null;

  constructor(
    private readonly ports: ComposerFormattingPorts,
    private readonly injector: Injector,
  ) {
    // Formatting UI belongs to the exact Account, Conversation and editing target.
    // Draft persistence remains with its existing Conversation owner.
    effect(
      () => {
        ports.context();
        untracked(() => {
          this.selection = null;
          ports.previewing.set(false);
        });
      },
      { injector },
    );
  }

  /** Forget the saved selection, which belonged to text that is gone. */
  clearSelection(): void {
    this.selection = null;
  }

  /**
   * The keys the composer owns that Angular's per-key bindings cannot express.
   *
   * Two jobs. **Formatting chords** are user-rebindable, so they are data rather than a
   * template string and have to be resolved through the registry. Only `format.` ids are
   * claimed — everything else (the quick switcher, the room hops) is left to bubble to the
   * page handler, so those still work while typing. `stopPropagation` is what keeps a claimed
   * chord off that handler, and `preventDefault` is not optional: Chrome and Firefox bind
   * Ctrl+B to the bookmarks bar.
   *
   * **Shift+Enter** continues a list. It cannot live in `onEnter`, which Angular only fires
   * when no modifier is held — the newline today is the browser's own default.
   */
  onKeydown(event: Event): void {
    const keyEvent = event as KeyboardEvent;
    // Never rewrite the buffer mid-composition; the same reason onInput and onEnter guard.
    if (keyEvent.isComposing) {
      return;
    }

    if (keyEvent.key === 'Enter' && keyEvent.shiftKey) {
      this.continueListAtCaret(keyEvent);
      return;
    }

    const hit = this.ports.shortcuts.resolve(keyEvent);
    const action = hit ? SHORTCUT_ACTIONS[hit.id] : undefined;
    if (!action) {
      return; // not a formatting chord — let it reach the page-level handler
    }
    keyEvent.preventDefault();
    keyEvent.stopPropagation();
    this.onFormat(action);
  }

  /** Carry a list or quote marker onto the next line, or end the list on an empty item. */
  private continueListAtCaret(event: KeyboardEvent): void {
    const el = this.ports.textarea()?.nativeElement;
    const caret = el?.selectionStart ?? this.ports.text().length;
    // Only meaningful for a collapsed caret: with a selection, Shift+Enter replaces it, which
    // is the browser's job.
    if (el && el.selectionStart !== el.selectionEnd) {
      return;
    }
    const result = continueList(this.ports.text(), caret);
    if (!result) {
      return; // not in a list — let the browser insert its newline
    }
    event.preventDefault();
    this.applyEdit(result);
  }

  /**
   * Put a message's text into the composer as a blockquote to write around.
   *
   * Called by the host list when a row raises `quote`, rather than driven by an input,
   * because quoting is a one-shot event and not a state the composer should be able to
   * re-enter: an input would need a token to distinguish "quoted twice" from "re-rendered".
   *
   * The block goes ABOVE anything already typed and the caret lands at the very end.
   * Whatever is in the box is the response being written, so the quote belongs before it
   * and the caret belongs after it; quoting a second message stacks rather than replaces.
   * Routed through the same `applyEdit` a formatting chord uses, so the textarea, the
   * autocompletes and the typing notice all stay in step.
   */
  insertQuote(block: string): void {
    if (!block) {
      return;
    }
    // Quoting out of an edit has to wait for the edit to actually end.
    //
    // The host clears its `editingId` and calls this in the SAME tick, so `editing()` is
    // still true here — the input only changes on the next change detection. The draft
    // effect then takes its `!editing && wasEditing` branch and does an unconditional
    // `text.set(draft)`, which would land AFTER this insert and silently discard the
    // quote. afterNextRender runs after that effect, so the quote survives.
    //
    // afterNextRender, NOT queueMicrotask: the app is zoneless, so the host's signal write
    // only schedules change detection (rAF) and a microtask would still run before the
    // effect. Same reason `onTogglePreview` uses it.
    if (this.ports.editing()) {
      afterNextRender(() => this.insertQuoteNow(block), {
        injector: this.injector,
      });
      return;
    }
    this.insertQuoteNow(block);
  }

  private insertQuoteNow(block: string): void {
    // A preview hides the textarea, and `applyEdit` focuses it — on a `display: none`
    // element that is a no-op, stranding the caret on <body>. Quoting means you are about
    // to write, so drop back to the editor first.
    this.ports.previewing.set(false);
    const existing = this.ports.text();
    const text = existing ? block + existing : block;
    this.applyEdit({
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
  }

  /** Apply a formatting action to the current selection. */
  onFormat(action: FormatAction): void {
    if (this.ports.composing()) return;
    const el = this.ports.textarea()?.nativeElement;
    const value = this.ports.text();
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    this.applyEdit(applyFormat(value, start, end, action));
  }

  /** Apply the selection saved before focus moved into the Format surface. */
  onMenuFormat(action: FormatAction): void {
    const saved = this.selection;
    if (!saved || !this.isCurrent(saved) || this.ports.composing()) return;
    const result = applyFormat(saved.text, saved.start, saved.end, action);
    this.ports.previewing.set(false);
    this.applyEdit(result);
    this.selection = {
      context: saved.context,
      text: result.text,
      start: result.selectionStart,
      end: result.selectionEnd,
    };
    this.restoreSelection(true);
  }

  /** Land an edit in the field, then do the bookkeeping a keystroke would have done. */
  private applyEdit(result: EditResult): void {
    this.ports.write(result);
    // Without this an open mention menu keeps a query anchored to a caret that has moved —
    // accepting it then splices at a stale offset — and a message begun entirely from the
    // format action never announces that anyone is typing.
    this.ports.syncMenus();
    this.ports.typing(result.text.trim().length > 0);
  }

  /** Swap between writing and previewing, returning focus to the input on the way back. */
  onTogglePreview(): void {
    if (this.ports.composing()) return;
    const next = !this.ports.previewing();
    if (next) this.captureSelection();
    this.ports.previewing.set(next);
    if (next) {
      const context = this.ports.context();
      afterNextRender(
        () => {
          if (context === this.ports.context() && this.ports.previewing()) {
            this.ports.previewPanel()?.nativeElement.focus();
          }
        },
        { injector: this.injector },
      );
    } else {
      this.restoreSelection(true);
    }
  }

  /** Save the exact caret or selection before the Aa trigger takes focus. */
  captureSelection(): void {
    const el = this.ports.textarea()?.nativeElement;
    if (!el || this.ports.composing()) return;
    this.selection = {
      context: this.ports.context(),
      text: this.ports.text(),
      start: el.selectionStart,
      end: el.selectionEnd,
    };
  }

  restoreSelection(focus = false): void {
    const saved = this.selection;
    if (!saved) return;
    const restore = () => {
      if (!this.isCurrent(saved) || this.ports.composing()) return;
      const el = this.ports.textarea()?.nativeElement;
      if (focus) el?.focus();
      el?.setSelectionRange(saved.start, saved.end);
      this.ports.autoGrow();
    };
    restore();
    if (focus) afterNextRender(restore, { injector: this.injector });
  }

  private isCurrent(saved: FormatSelection): boolean {
    return (
      saved.context === this.ports.context() && saved.text === this.ports.text()
    );
  }
}
