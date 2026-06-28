import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { IonIcon, IonProgressBar } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { addOutline, happyOutline, send } from 'ionicons/icons';
import { EmojiPickerComponent } from '@trinity/ui';
import { MediaPickerService } from '../media-picker/media-picker.service';

const MAX_HEIGHT_PX = 200;

/**
 * Discord-style composer: Enter sends, Shift+Enter inserts a newline. In edit mode
 * it is prefilled with the message draft and Esc cancels. An emoji button opens a
 * picker that inserts at the cursor.
 */
@Component({
  selector: 'trn-message-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonIcon, IonProgressBar, EmojiPickerComponent],
  templateUrl: './message-composer.component.html',
  styleUrl: './message-composer.component.scss',
})
export class MessageComposerComponent {
  readonly roomName = input('');
  /** Idle placeholder override (e.g. the thread composer); defaults to "Message #room". */
  readonly placeholder = input('');
  readonly editing = input(false);
  readonly draft = input('');
  /** Sender name of the message being replied to, or '' when not replying. */
  readonly replyingTo = input('');
  /** Upload fraction in [0, 1] while an attachment uploads, else null (idle). */
  readonly uploadProgress = input<number | null>(null);
  readonly submitText = output<string>();
  readonly submitMedia = output<File>();
  readonly cancelEdit = output<void>();
  readonly cancelReply = output<void>();
  readonly editLast = output<void>();

  readonly text = signal('');
  readonly pickerOpen = signal(false);
  /** Whether to show a determinate bar — true once the first real fraction lands.
   * Until then (metadata probe + thumbnail upload) the bar is indeterminate so it
   * reads as "working" rather than a stalled 0%. */
  readonly uploadDeterminate = computed(() => (this.uploadProgress() ?? 0) > 0);
  /** Whole-percent upload progress for the determinate bar's label. */
  readonly uploadPercent = computed(() =>
    Math.round((this.uploadProgress() ?? 0) * 100),
  );
  private readonly textarea = viewChild<ElementRef<HTMLTextAreaElement>>('ta');
  private readonly fileInput =
    viewChild<ElementRef<HTMLInputElement>>('fileInput');
  private readonly picker = inject(MediaPickerService);
  private readonly destroyRef = inject(DestroyRef);
  private wasEditing = false;
  private wasReplying = false;

  constructor() {
    addIcons({ addOutline, happyOutline, send });
    // Focus the input when a reply is started.
    effect(() => {
      const replying = !!this.replyingTo();
      if (replying && !this.wasReplying) {
        queueMicrotask(() => this.textarea()?.nativeElement.focus());
      }
      this.wasReplying = replying;
    });
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
    this.submit();
  }

  /** Emit the current text (shared by Enter and the send button). */
  submit(): void {
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

  /** Attach button: native gallery picker on device, else the hidden file input. */
  onAttach(): void {
    if (this.picker.available) {
      this.picker
        .pickImage()
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((file) => {
          if (file) {
            this.submitMedia.emit(file);
          }
        });
    } else {
      this.fileInput()?.nativeElement.click();
    }
  }

  /** Hidden file input change → emit the picked file, then reset for re-picking. */
  onFilePicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      this.submitMedia.emit(file);
    }
    input.value = ''; // let the same file be picked again
  }

  onEscape(): void {
    if (this.pickerOpen()) {
      this.pickerOpen.set(false);
      return;
    }
    if (this.replyingTo()) {
      this.cancelReply.emit();
      return;
    }
    if (this.editing()) {
      this.cancelEdit.emit();
    }
  }

  /** Insert an emoji at the cursor (or append), then keep the textarea focused. */
  insertEmoji(emoji: string): void {
    const el = this.textarea()?.nativeElement;
    const value = this.text();
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    this.text.set(value.slice(0, start) + emoji + value.slice(end));
    this.pickerOpen.set(false);
    queueMicrotask(() => {
      const pos = start + emoji.length;
      el?.focus();
      el?.setSelectionRange(pos, pos);
      this.autoGrow();
    });
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
