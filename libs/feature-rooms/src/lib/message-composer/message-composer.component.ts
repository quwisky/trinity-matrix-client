import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

const MAX_HEIGHT_PX = 200;

/** Discord-style composer: Enter sends, Shift+Enter inserts a newline. */
@Component({
  selector: 'app-message-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './message-composer.component.html',
  styleUrl: './message-composer.component.scss',
})
export class MessageComposerComponent {
  readonly roomName = input('');
  readonly send = output<string>();

  readonly text = signal('');
  private readonly textarea = viewChild<ElementRef<HTMLTextAreaElement>>('ta');

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
    this.send.emit(value);
    this.text.set('');
    queueMicrotask(() => this.autoGrow());
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
