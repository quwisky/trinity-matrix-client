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
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideImagePlay,
  lucidePaperclip,
  lucidePlus,
  lucideSend,
  lucideSmile,
} from '@ng-icons/lucide';
import { HlmProgress, HlmProgressIndicator } from '@trinity/helm/progress';
import { HlmTextarea } from '@trinity/helm/textarea';
import { HlmTooltip } from '@trinity/helm/tooltip';
import { TrnToastService } from '@trinity/helm/overlay';
import { EmojiSearch, PickerComponent } from '@ctrl/ngx-emoji-mart';
import {
  EmojiService,
  type EmojiData,
  type EmojiEvent,
} from '@ctrl/ngx-emoji-mart/ngx-emoji';
import { ThemeService } from '@trinity/platform-native';
import {
  GifService,
  GifSettingsService,
  type GifResult,
} from '@trinity/data-access-gif';
import { MediaPickerService } from '../media-picker/media-picker.service';
import { GifPickerComponent } from '../gif-picker/gif-picker.component';

const MAX_HEIGHT_PX = 200;

/**
 * A `:shortcode` being typed at the caret: a `:` at a word boundary, then at
 * least two shortcode characters, with no closing colon yet. The leading
 * boundary keeps URLs and times (`http://`, `8:30`) from opening the menu.
 */
const EMOJI_TRIGGER = /(?:^|\s):([a-z0-9_+-]{2,})$/i;
/** A fully typed `:shortcode:` (closing colon present) for inline replacement. */
const EMOJI_COMPLETE = /(?:^|\s):([a-z0-9_+-]+):$/i;
/** How many suggestions the menu offers at once. */
const EMOJI_SUGGESTION_LIMIT = 8;

/**
 * Discord-style composer: Enter sends, Shift+Enter inserts a newline. In edit mode
 * it is prefilled with the message draft and Esc cancels. An emoji button opens a
 * picker that inserts at the cursor.
 */
@Component({
  selector: 'trn-message-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgIcon,
    HlmTooltip,
    HlmTextarea,
    PickerComponent,
    GifPickerComponent,
    HlmProgress,
    HlmProgressIndicator,
  ],
  viewProviders: [
    provideIcons({
      lucideImagePlay,
      lucidePaperclip,
      lucidePlus,
      lucideSend,
      lucideSmile,
    }),
  ],
  templateUrl: './message-composer.component.html',
  styleUrl: './message-composer.component.scss',
})
export class MessageComposerComponent {
  readonly roomName = input('');
  /** Idle placeholder override (e.g. the thread composer); defaults to "Message #room". */
  readonly placeholder = input('');
  readonly editing = input(false);
  readonly draft = input('');
  /**
   * Id of the message being edited (null when not editing). The prefill keys on
   * this — not on {@link draft} — so re-targeting to a different message refreshes
   * the field, while a mid-edit body change of the *same* target (redaction, a
   * concurrent multi-device edit, a late echo) never clobbers in-progress text.
   */
  readonly editTargetId = input<string | null>(null);
  /** Active room/thread id. A change discards any staged (unsent) attachment —
   * the composer instance is reused across rooms, so it must not leak. */
  readonly roomId = input<string | null>(null);
  /** Sender name of the message being replied to, or '' when not replying. */
  readonly replyingTo = input('');
  /** Upload fraction in [0, 1] while an attachment uploads, else null (idle). */
  readonly uploadProgress = input<number | null>(null);
  readonly submitText = output<string>();
  /** A staged attachment plus its optional caption, emitted on submit. */
  readonly submitMedia = output<{ file: File; caption: string }>();
  readonly cancelEdit = output<void>();
  readonly cancelReply = output<void>();
  readonly editLast = output<void>();

  readonly text = signal('');
  /** A picked/pasted attachment held for a caption, sent on the next submit
   * (Enter / send button) — not uploaded immediately. */
  readonly pendingFile = signal<File | null>(null);
  /** Object URL previewing a staged image, else null (revoked on clear/destroy). */
  readonly pendingPreview = signal<string | null>(null);
  readonly pickerOpen = signal(false);
  /** Whether the GIF search grid is open (mutually exclusive with the emoji picker). */
  readonly gifPickerOpen = signal(false);
  /** True while a chosen GIF is being fetched, before its media upload starts. */
  readonly gifDownloading = signal(false);
  /** The GIF affordance is offered only once a provider + API key are configured. */
  readonly gifEnabled = computed(() => this.gifSettings.configured());
  /** Match the emoji picker's chrome to the app's active theme. */
  readonly isDarkMode = computed(() => this.theme.resolved() === 'dark');
  /** The `:shortcode` fragment under the caret, or null when the menu is closed. */
  readonly emojiQuery = signal<string | null>(null);
  /** Ranked emoji suggestions for the current query (from emoji-mart's index). */
  readonly emojiMatches = computed<EmojiData[]>(() => {
    const q = this.emojiQuery();
    if (q === null) {
      return [];
    }
    return this.emojiSearch.search(q, undefined, EMOJI_SUGGESTION_LIMIT) ?? [];
  });
  /** The menu is shown only when a query yields at least one match. */
  readonly emojiOpen = computed(() => this.emojiMatches().length > 0);
  /** Index of the highlighted suggestion. */
  readonly emojiActiveIndex = signal(0);
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
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly emojiSearch = inject(EmojiSearch);
  private readonly emojiService = inject(EmojiService);
  private readonly theme = inject(ThemeService);
  private readonly gifs = inject(GifService);
  private readonly gifSettings = inject(GifSettingsService);
  private wasEditing = false;
  private wasEditTargetId: string | null = null;
  private wasReplying = false;

  private wasRoomId: string | null | undefined = undefined;

  constructor() {
    // Revoke a staged image's preview object URL on teardown.
    this.destroyRef.onDestroy(() => this.setPreview(null));

    // Drop a staged (unsent) attachment when the room/thread changes — it was
    // staged to send here, and the reused composer must not carry it elsewhere.
    effect(() => {
      const id = this.roomId();
      if (id !== this.wasRoomId) {
        this.wasRoomId = id;
        untracked(() => this.clearPending());
      }
    });

    // Highlight the first suggestion whenever the result set changes.
    effect(() => {
      this.emojiMatches();
      this.emojiActiveIndex.set(0);
    });
    // Focus the input when a reply is started.
    effect(() => {
      const replying = !!this.replyingTo();
      if (replying && !this.wasReplying) {
        queueMicrotask(() => this.textarea()?.nativeElement.focus());
      }
      this.wasReplying = replying;
    });
    // Prefill on entering edit mode, or when the edit TARGET changes while still
    // editing (a different message was selected). Keyed on editTargetId — not the
    // draft body — and draft() is read untracked, so a mid-edit body change of the
    // same target (redaction, concurrent multi-device edit, a late echo) neither
    // fires this effect nor overwrites the user's in-progress text. Clear on
    // leaving edit mode. Typing never re-fires this (it updates `text`, unread here).
    effect(() => {
      const editing = this.editing();
      const targetId = this.editTargetId();
      if (editing && (!this.wasEditing || targetId !== this.wasEditTargetId)) {
        this.text.set(untracked(() => this.draft()));
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
      this.wasEditTargetId = targetId;
    });
  }

  onInput(event: Event): void {
    this.text.set((event.target as HTMLTextAreaElement).value);
    this.autoGrow();
    // Don't touch the menu mid-IME-composition: the in-progress reading is
    // transient ASCII that would mis-trigger `:shortcode` matching, and
    // rewriting the value/caret during composition drops characters.
    if (!(event as InputEvent).isComposing) {
      this.syncEmojiAutocomplete();
    }
  }

  onEnter(event: Event): void {
    const keyEvent = event as KeyboardEvent;
    // An Enter that confirms an IME candidate must reach neither send nor
    // accept — let the composition commit normally.
    if (keyEvent.isComposing) {
      return;
    }
    if (this.emojiOpen()) {
      keyEvent.preventDefault();
      this.acceptEmoji();
      return;
    }
    if (keyEvent.shiftKey) {
      return; // Shift+Enter → newline (default textarea behavior)
    }
    keyEvent.preventDefault();
    this.submit();
  }

  /** Tab accepts the highlighted suggestion when the emoji menu is open. */
  onTab(event: Event): void {
    if (this.emojiOpen()) {
      event.preventDefault();
      this.acceptEmoji();
    }
  }

  /** Arrow Down moves the emoji highlight when the menu is open. */
  onArrowDown(event: Event): void {
    if (this.emojiOpen()) {
      event.preventDefault();
      this.moveEmojiSelection(1);
    }
  }

  /** Closing the field hides the menu; a menu click keeps focus (see template). */
  onBlur(): void {
    this.emojiQuery.set(null);
  }

  /** Send on Enter / the send button: a staged attachment (with the text as its
   * caption) takes precedence, else the plain text message. */
  submit(): void {
    // A staged attachment sends as media with the text as its caption. Never mixes
    // with an edit (attach is disabled while editing), so edit mode ignores it.
    const file = this.editing() ? null : this.pendingFile();
    if (file) {
      this.submitMedia.emit({ file, caption: this.text().trim() });
      // A media send carries no reply relation, so end any active reply — else
      // the banner lingers and the next plain message silently replies to a
      // now-stale target.
      if (this.replyingTo()) {
        this.cancelReply.emit();
      }
      this.clearPending();
      this.text.set('');
      this.emojiQuery.set(null);
      queueMicrotask(() => this.autoGrow());
      return;
    }
    const value = this.text().trim();
    if (!value) {
      return;
    }
    this.submitText.emit(value);
    this.emojiQuery.set(null);
    if (!this.editing()) {
      // Edits clear via editing → false; new messages clear here.
      this.text.set('');
      queueMicrotask(() => this.autoGrow());
    }
  }

  /**
   * Recompute the emoji menu from the text before the caret. A fully typed
   * `:shortcode:` is converted to its emoji inline; otherwise an in-progress
   * `:fragment` opens (or, with no match, closes) the suggestion menu.
   */
  private syncEmojiAutocomplete(): void {
    const el = this.textarea()?.nativeElement;
    const caret = el?.selectionStart ?? this.text().length;
    const before = this.text().slice(0, caret);

    const complete = EMOJI_COMPLETE.exec(before);
    if (complete) {
      const char = this.nativeForShortcode(complete[1].toLowerCase());
      if (char) {
        const start = caret - complete[1].length - 2; // ":" + code + ":"
        this.replaceRange(start, caret, char);
        this.emojiQuery.set(null);
        return;
      }
    }

    const trigger = EMOJI_TRIGGER.exec(before);
    this.emojiQuery.set(trigger ? trigger[1].toLowerCase() : null);
  }

  /** Native emoji for an exact shortcode, or undefined if it isn't a real one. */
  private nativeForShortcode(code: string): string | undefined {
    const data = this.emojiService.getData(code);
    return data
      ? (this.emojiService.getSanitizedData(data).native ?? undefined)
      : undefined;
  }

  /** The emoji picker chose an emoji → insert its native character at the cursor. */
  onPickerSelect(event: EmojiEvent): void {
    const native = event.emoji.native;
    if (native) {
      this.insertEmoji(native);
    }
  }

  /** Toggle the emoji picker, closing the GIF grid (only one overlay at a time). */
  toggleEmojiPicker(): void {
    this.gifPickerOpen.set(false);
    this.pickerOpen.set(!this.pickerOpen());
  }

  /** Toggle the GIF grid, closing the emoji picker (only one overlay at a time). */
  toggleGifPicker(): void {
    this.pickerOpen.set(false);
    this.gifPickerOpen.set(!this.gifPickerOpen());
  }

  /** A GIF was chosen → download it and send it through the media path (works in
   * rooms and threads, encrypted or not). Sends immediately, like other GIF UIs. */
  onGifSelect(gif: GifResult): void {
    if (this.gifDownloading()) {
      return;
    }
    this.gifDownloading.set(true);
    this.gifs
      .download(gif)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (file) => {
          this.gifDownloading.set(false);
          this.gifPickerOpen.set(false);
          // A media send carries no reply relation (see submit()); close any
          // active reply so its banner doesn't linger over the next message.
          if (this.replyingTo()) {
            this.cancelReply.emit();
          }
          this.submitMedia.emit({ file, caption: '' });
        },
        error: () => {
          this.gifDownloading.set(false);
          this.toast.show('Could not load that GIF.', {
            duration: 4000,
            variant: 'destructive',
          });
        },
      });
  }

  /** Accept a suggestion: swap the `:fragment` under the caret for the emoji. */
  acceptEmoji(index = this.emojiActiveIndex()): void {
    const match = this.emojiMatches()[index];
    const native = match?.native;
    if (!native) {
      return;
    }
    const el = this.textarea()?.nativeElement;
    const caret = el?.selectionStart ?? this.text().length;
    const trigger = EMOJI_TRIGGER.exec(this.text().slice(0, caret));
    if (trigger) {
      const start = caret - trigger[1].length - 1; // ":" + fragment
      this.replaceRange(start, caret, native);
    } else {
      // Caret drifted off the fragment — fall back to a plain cursor insert.
      this.insertEmoji(native);
    }
    this.emojiQuery.set(null);
  }

  private moveEmojiSelection(delta: number): void {
    const n = this.emojiMatches().length;
    if (n === 0) {
      return;
    }
    const next = (this.emojiActiveIndex() + delta + n) % n;
    this.emojiActiveIndex.set(next);
    // aria-activedescendant doesn't auto-scroll the listbox; keep the highlight
    // visible when the result set overflows the menu's max-height.
    queueMicrotask(() =>
      document
        .getElementById(`emoji-suggestion-${next}`)
        ?.scrollIntoView?.({ block: 'nearest' }),
    );
  }

  /** Replace text[start, end) with `insert`, then restore focus and the caret. */
  private replaceRange(start: number, end: number, insert: string): void {
    const value = this.text();
    this.text.set(value.slice(0, start) + insert + value.slice(end));
    queueMicrotask(() => {
      const el = this.textarea()?.nativeElement;
      const pos = start + insert.length;
      el?.focus();
      el?.setSelectionRange(pos, pos);
      this.autoGrow();
    });
  }

  /** Attach button: native gallery picker on device, else the hidden file input. */
  onAttach(): void {
    if (this.picker.available) {
      this.picker
        .pickImage()
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (file) => {
            if (file) {
              this.stagePending(file);
            }
          },
          // A user-cancel resolves to null above; this catches a denied photo
          // permission (or a genuine picker failure) instead of leaving it
          // unhandled, and shows the reason.
          error: (err: unknown) => void this.showAttachError(err),
        });
    } else {
      this.fileInput()?.nativeElement.click();
    }
  }

  /** Surface a gallery-picker failure (notably denied photo access) as a toast. */
  private showAttachError(err: unknown): void {
    this.toast.show(
      err instanceof Error ? err.message : 'Could not open the gallery.',
      { duration: 4000, variant: 'destructive' },
    );
  }

  /** Hidden file input change → stage the picked file, then reset for re-picking. */
  onFilePicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      this.stagePending(file);
    }
    input.value = ''; // let the same file be picked again
  }

  /** Hold a picked/pasted file for a caption instead of sending immediately.
   * A preview object URL is made for images and revoked when it's replaced. */
  private stagePending(file: File): void {
    this.setPreview(
      file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
    );
    this.pendingFile.set(file);
    queueMicrotask(() => this.textarea()?.nativeElement.focus());
  }

  /** Drop the staged attachment (× button, Escape, or after it's sent). */
  clearPending(): void {
    this.setPreview(null);
    this.pendingFile.set(null);
  }

  /** Swap the preview object URL, revoking the previous one. */
  private setPreview(url: string | null): void {
    const prev = this.pendingPreview();
    if (prev && prev !== url) {
      URL.revokeObjectURL(prev);
    }
    this.pendingPreview.set(url);
  }

  /**
   * Paste an image from the clipboard → send it as an attachment (Discord-style),
   * via the same media path as the picker. Pasted images land in `files` on most
   * engines; some (older WebKit) expose them only as `items` of kind `file`. Text
   * paste is left untouched.
   */
  onPaste(event: ClipboardEvent): void {
    // While editing, attachments are disabled (an edit can't become media), so
    // let the paste fall through to the textarea. Also one upload at a time.
    if (this.editing() || this.uploadProgress() !== null) {
      return;
    }
    const data = event.clipboardData;
    if (!data) {
      return;
    }
    let image: File | null =
      Array.from(data.files).find((f) => f.type.startsWith('image/')) ?? null;
    if (!image) {
      for (const item of Array.from(data.items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          image = item.getAsFile();
          break;
        }
      }
    }
    if (image) {
      event.preventDefault(); // don't also drop the raw image into the textarea
      this.stagePending(image);
    }
  }

  onEscape(): void {
    if (this.emojiOpen()) {
      this.emojiQuery.set(null);
      return;
    }
    if (this.pickerOpen()) {
      this.pickerOpen.set(false);
      return;
    }
    if (this.gifPickerOpen()) {
      this.gifPickerOpen.set(false);
      return;
    }
    if (this.pendingFile()) {
      this.clearPending();
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
    if (this.emojiOpen()) {
      event.preventDefault();
      this.moveEmojiSelection(-1);
      return;
    }
    // Empty composer + Up arrow → edit the last message (Discord-style).
    // Otherwise (editing, typed text, or a staged attachment) move the cursor.
    if (this.editing() || this.text().length > 0 || this.pendingFile()) {
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
