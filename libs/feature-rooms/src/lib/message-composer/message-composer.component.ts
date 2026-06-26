import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

const MAX_HEIGHT_PX = 200;

/**
 * Discord-style composer: Enter sends, Shift+Enter inserts a newline. In edit mode
 * it is prefilled with the message draft and Esc cancels.
 */
@Component({
  selector: 'app-message-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './message-composer.component.html',
  styleUrl: './message-composer.component.scss',
})
export class MessageComposerComponent {
  readonly roomName = input('');
  readonly editing = input(false);
  readonly draft = input('');
  readonly submitText = output<string>();
  readonly cancelEdit = output<void>();
  readonly editLast = output<void>();

  readonly text = signal('');
  private readonly textarea = viewChild<ElementRef<HTMLTextAreaElement>>('ta');
  private wasEditing = false;

  constructor() {
    // Prefill on entering edit mode; clear on leaving it.
    effect(() => {
      const editing = this.editing();
      if (editing && !this.wasEditing) {
        this.text.set(this.draft());
        queueMicrotask(() => {
          const el = this.textarea()?.nativeElement;
          el?.focus();
          el?.setSelectionRange(el.value.length, el.value.length);
          this.autoGrow();
        });
      } else if (!editing && this.wasEditing) {
        this.text.set('');
        queueMicrotask(() => this.autoGrow());
      }
      this.wasEditing = editing;
    });
  }

  onInput(event: Event): void {
    this.text.set((event.target as HTMLTextAreaElement).value);
    this.autoGrow();
  }

  onEnter(event: Event): void {
    const keyEvent = event as KeyboardEvent;
    if (keyEvent.shiftKey) {
      return; // Shift+Enter → newline (default textarea behavior)
    }
    keyEvent.preventDefault();
    const value = this.text().trim();
    if (!value) {
      return;
    }
    this.submitText.emit(value);
    if (!this.editing()) {
      // Edits clear via editing → false; new messages clear here.
      this.text.set('');
      queueMicrotask(() => this.autoGrow());
    }
  }

  onEscape(): void {
    if (this.editing()) {
      this.cancelEdit.emit();
    }
  }

  onArrowUp(event: Event): void {
    // Empty composer + Up arrow → edit the last message (Discord-style).
    // Otherwise let the key move the cursor normally.
    if (this.editing() || this.text().length > 0) {
      return;
    }
    event.preventDefault();
    this.editLast.emit();
  }

  private autoGrow(): void {
    const el = this.textarea()?.nativeElement;
    if (!el) {
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }
}
