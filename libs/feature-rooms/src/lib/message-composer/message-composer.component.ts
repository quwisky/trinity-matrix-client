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
  lucideMapPin,
  lucideMic,
  lucidePaperclip,
  lucidePlus,
  lucideSend,
  lucideSmile,
  lucideTrash2,
  lucideVote,
} from '@ng-icons/lucide';
import { HlmProgress, HlmProgressIndicator } from '@trinity/helm/progress';
import { HlmSpinner } from '@trinity/helm/spinner';
import { HlmTextarea } from '@trinity/helm/textarea';
import { HlmTooltip } from '@trinity/helm/tooltip';
import { TrnToastService } from '@trinity/helm/overlay';
import { EmojiSearch, PickerComponent } from '@ctrl/ngx-emoji-mart';
import {
  EmojiService,
  type EmojiData,
  type EmojiEvent,
} from '@ctrl/ngx-emoji-mart/ngx-emoji';
import {
  DraftStoreService,
  ThemeService,
  VoiceRecorderService,
} from '@trinity/platform-native';
import {
  GifService,
  GifSettingsService,
  type GifResult,
} from '@trinity/data-access-gif';
import { TimelineService } from '@trinity/data-access-timeline';
import { type Mention } from '@trinity/util-matrix';
import { MediaPickerService } from '../media-picker/media-picker.service';
import { GifPickerComponent } from '../gif-picker/gif-picker.component';
import { CreatePollService } from '../poll/create-poll.service';
import { LocationShareService } from '../location-share/location-share.service';

/** A room member offered by the @-mention autocomplete. */
export interface MentionMember {
  userId: string;
  name: string;
}

/** What the composer emits on submit: the message text plus any @-mentioned users. */
export interface ComposerSubmit {
  text: string;
  mentions: Mention[];
}

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
 * An `@mention` being typed at the caret: `@` at a word boundary (so an email's
 * `a@b` doesn't trigger) followed by the query so far (may be empty right after `@`).
 */
const MENTION_TRIGGER = /(?:^|\s)@([^\s@]*)$/;
/** How many member suggestions the mention menu offers at once. */
const MENTION_SUGGESTION_LIMIT = 8;

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
    HlmSpinner,
  ],
  viewProviders: [
    provideIcons({
      lucideImagePlay,
      lucideMapPin,
      lucideMic,
      lucidePaperclip,
      lucidePlus,
      lucideSend,
      lucideSmile,
      lucideTrash2,
      lucideVote,
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
  /** Room members, for the @-mention autocomplete (empty disables mentions). */
  readonly members = input<MentionMember[]>([]);
  /**
   * Whether to offer the room-scoped rich actions (poll, location, voice).
   * These act on the *active room* via their own services, so they can't be routed
   * into a thread — the thread composer sets this false to hide them.
   */
  readonly richActions = input(true);
  /** Upload fraction in [0, 1] while an attachment uploads, else null (idle). */
  readonly uploadProgress = input<number | null>(null);
  readonly submitText = output<ComposerSubmit>();
  /** A staged attachment plus its optional caption, emitted on submit. */
  readonly submitMedia = output<{ file: File; caption: string }>();
  readonly cancelEdit = output<void>();
  readonly cancelReply = output<void>();
  readonly editLast = output<void>();
  /**
   * The user typed something (or cleared the field). The host debounces this into a
   * Matrix typing notification — `true` while there is text to send, `false` once the
   * field is empty. The composer stays presentational; the room decides where the
   * notification goes.
   */
  readonly typing = output<boolean>();

  readonly text = signal('');
  /** A picked/pasted attachment held for a caption, sent on the next submit
   * (Enter / send button) — not uploaded immediately. */
  readonly pendingFile = signal<File | null>(null);
  /** Object URL previewing a staged image, else null (revoked on clear/destroy). */
  readonly pendingPreview = signal<string | null>(null);
  readonly pickerOpen = signal(false);
  /** Whether the GIF search grid is open (mutually exclusive with the emoji picker). */
  readonly gifPickerOpen = signal(false);
  /** True while a voice message is being recorded. */
  readonly recordingVoice = signal(false);
  /** Elapsed recording time in seconds, for the live timer. */
  private readonly voiceElapsed = signal(0);
  /** Interval handle for the recording timer, cleared on stop/cancel/destroy. */
  private voiceTimer: ReturnType<typeof setInterval> | null = null;
  /** True between a start() call and its mic-acquisition resolving (re-entry guard). */
  private voiceStarting = false;
  /** Set on teardown so an in-flight mic acquisition can abort instead of orphaning. */
  private destroyed = false;
  /** `m:ss` label for the running recording timer. */
  readonly voiceTimeLabel = computed(() => {
    const total = this.voiceElapsed();
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  });
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
  /** The `@mention` query under the caret, or null when the menu is closed. */
  readonly mentionQuery = signal<string | null>(null);
  /** Members matching the current query (prefix matches first), capped for the menu. */
  readonly mentionMatches = computed<MentionMember[]>(() => {
    const q = this.mentionQuery();
    if (q === null) {
      return [];
    }
    const query = q.toLowerCase();
    return this.members()
      .filter(
        (m) =>
          m.name.toLowerCase().includes(query) ||
          m.userId.toLowerCase().includes(query),
      )
      .sort(
        (a, b) =>
          Number(b.name.toLowerCase().startsWith(query)) -
          Number(a.name.toLowerCase().startsWith(query)),
      )
      .slice(0, MENTION_SUGGESTION_LIMIT);
  });
  /** The mention menu shows only when a query yields at least one member. */
  readonly mentionOpen = computed(() => this.mentionMatches().length > 0);
  /** Index of the highlighted member suggestion. */
  readonly mentionActiveIndex = signal(0);
  /** Users chosen via the mention menu, for `m.mentions` + pills on submit. */
  private readonly mentions = signal<Mention[]>([]);
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
  private readonly createPollSvc = inject(CreatePollService);
  private readonly locationShare = inject(LocationShareService);
  private readonly timeline = inject(TimelineService);
  private readonly voiceRecorder = inject(VoiceRecorderService);
  private readonly destroyRef = inject(DestroyRef);

  /** Whether this device can record voice (mic + MediaRecorder present). */
  get voiceSupported(): boolean {
    return this.voiceRecorder.supported;
  }
  private readonly emojiSearch = inject(EmojiSearch);
  private readonly emojiService = inject(EmojiService);
  private readonly theme = inject(ThemeService);
  private readonly gifs = inject(GifService);
  private readonly gifSettings = inject(GifSettingsService);
  private readonly drafts = inject(DraftStoreService);
  private wasEditing = false;
  private wasEditTargetId: string | null = null;
  private wasReplying = false;

  private wasRoomId: string | null | undefined = undefined;

  constructor() {
    // Revoke a staged image's preview object URL on teardown.
    this.destroyRef.onDestroy(() => this.setPreview(null));
    // Stop a running recording timer (and release the mic) if torn down mid-record.
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.clearVoiceTimer();
      if (this.recordingVoice() || this.voiceStarting) {
        this.voiceRecorder.cancel();
      }
    });

    // On a room/thread change: drop the staged (unsent) attachment — it was staged
    // to send here — and swap drafts. The composer instance is reused across rooms,
    // so without this a half-typed message would leak into the next conversation.
    effect(() => {
      const id = this.roomId();
      if (id !== this.wasRoomId) {
        const prev = this.wasRoomId;
        this.wasRoomId = id;
        untracked(() => {
          this.clearPending();
          // A recording belongs to the room it was started in — cancel it on a
          // room/thread switch so the mic doesn't stay open and a later Send can't
          // post the clip to the wrong room.
          if (this.recordingVoice()) {
            this.cancelVoiceRecording();
          }
          this.mentions.set([]); // tracked mentions belong to the old conversation
          // Drafts only apply to compose mode; in edit mode `text` is the edit body.
          if (!this.editing()) {
            if (prev != null) {
              this.drafts.set(prev, this.text());
            }
            this.text.set(id != null ? this.drafts.get(id) : '');
            queueMicrotask(() => this.autoGrow());
          }
        });
      }
    });

    // Highlight the first suggestion whenever either result set changes.
    effect(() => {
      this.emojiMatches();
      this.emojiActiveIndex.set(0);
    });
    effect(() => {
      this.mentionMatches();
      this.mentionActiveIndex.set(0);
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
        // Leaving edit mode restores the conversation's compose draft (empty when
        // none), so an edit interlude doesn't discard a half-typed message.
        const id = untracked(() => this.roomId());
        this.text.set(id != null ? this.drafts.get(id) : '');
        queueMicrotask(() => this.autoGrow());
      }
      this.wasEditing = editing;
      this.wasEditTargetId = targetId;
    });

    // Persist the compose draft on any text change (typing, emoji insert, inline
    // autocomplete). Gated to compose mode and the settled conversation so a room
    // switch's load never cross-saves; sending blanks the field, dropping the draft.
    effect(() => {
      const value = this.text();
      const id = this.roomId();
      untracked(() => {
        if (id != null && id === this.wasRoomId && !this.editing()) {
          this.drafts.set(id, value);
        }
      });
    });
  }

  onInput(event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;
    this.text.set(value);
    this.autoGrow();
    // Broadcast typing while there's something to send; an empty field stops it. The
    // host throttles the "start"s, so emitting on every keystroke is fine.
    this.typing.emit(value.trim().length > 0);
    // Don't touch the menu mid-IME-composition: the in-progress reading is
    // transient ASCII that would mis-trigger `:shortcode` matching, and
    // rewriting the value/caret during composition drops characters.
    if (!(event as InputEvent).isComposing) {
      this.syncEmojiAutocomplete();
      this.syncMentionAutocomplete();
    }
  }

  onEnter(event: Event): void {
    const keyEvent = event as KeyboardEvent;
    // An Enter that confirms an IME candidate must reach neither send nor
    // accept — let the composition commit normally.
    if (keyEvent.isComposing) {
      return;
    }
    if (this.mentionOpen()) {
      keyEvent.preventDefault();
      this.acceptMention();
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

  /** Tab accepts the highlighted suggestion when a menu is open. */
  onTab(event: Event): void {
    if (this.mentionOpen()) {
      event.preventDefault();
      this.acceptMention();
    } else if (this.emojiOpen()) {
      event.preventDefault();
      this.acceptEmoji();
    }
  }

  /** Arrow Down moves the highlight when a menu is open. */
  onArrowDown(event: Event): void {
    if (this.mentionOpen()) {
      event.preventDefault();
      this.moveMentionSelection(1);
    } else if (this.emojiOpen()) {
      event.preventDefault();
      this.moveEmojiSelection(1);
    }
  }

  /** Closing the field hides any open menu; a menu click keeps focus (see template). */
  onBlur(): void {
    this.emojiQuery.set(null);
    this.mentionQuery.set(null);
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
      this.resetMenus();
      queueMicrotask(() => this.autoGrow());
      return;
    }
    const value = this.text().trim();
    if (!value) {
      return;
    }
    this.submitText.emit({ text: value, mentions: this.activeMentions() });
    this.typing.emit(false); // a sent message ends the typing notification
    this.resetMenus();
    if (!this.editing()) {
      // Edits clear via editing → false; new messages clear here.
      this.text.set('');
      queueMicrotask(() => this.autoGrow());
    }
  }

  /** Close both autocomplete menus and forget the tracked mentions. */
  private resetMenus(): void {
    this.emojiQuery.set(null);
    this.mentionQuery.set(null);
    this.mentions.set([]);
  }

  /** Recompute the mention menu from the `@query` under the caret. */
  private syncMentionAutocomplete(): void {
    const el = this.textarea()?.nativeElement;
    const caret = el?.selectionStart ?? this.text().length;
    const trigger = MENTION_TRIGGER.exec(this.text().slice(0, caret));
    this.mentionQuery.set(trigger ? trigger[1] : null);
  }

  /** Accept a member: swap the `@query` for `@Name ` and record the mention. */
  acceptMention(index = this.mentionActiveIndex()): void {
    const member = this.mentionMatches()[index];
    if (!member) {
      return;
    }
    const el = this.textarea()?.nativeElement;
    const caret = el?.selectionStart ?? this.text().length;
    const trigger = MENTION_TRIGGER.exec(this.text().slice(0, caret));
    const display = `@${member.name}`;
    const start = trigger ? caret - trigger[1].length - 1 : caret; // drop "@query"
    this.replaceRange(start, caret, `${display} `);
    this.mentions.update((list) => [
      ...list,
      { userId: member.userId, display },
    ]);
    this.mentionQuery.set(null);
  }

  private moveMentionSelection(delta: number): void {
    const n = this.mentionMatches().length;
    if (n === 0) {
      return;
    }
    const next = (this.mentionActiveIndex() + delta + n) % n;
    this.mentionActiveIndex.set(next);
    queueMicrotask(() =>
      document
        .getElementById(`mention-suggestion-${next}`)
        ?.scrollIntoView?.({ block: 'nearest' }),
    );
  }

  /** Chosen mentions still present in the text (deleted ones dropped), deduped. */
  private activeMentions(): Mention[] {
    const text = this.text();
    const seen = new Set<string>();
    const out: Mention[] = [];
    for (const mention of this.mentions()) {
      if (text.includes(mention.display) && !seen.has(mention.userId)) {
        seen.add(mention.userId);
        out.push(mention);
      }
    }
    return out;
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

  /** Open the create-poll dialog (starts a poll in the active room on confirm). */
  openPollDialog(): void {
    void this.createPollSvc.open();
  }

  /** True while a location is being resolved and sent (drives the button's busy state). */
  readonly locationSharing = this.locationShare.sharing;

  /** Share the device's current location to the active room. */
  shareLocation(): void {
    this.locationShare.share();
  }

  /** Toggle the emoji picker, closing the other overlays (only one at a time). */
  toggleEmojiPicker(): void {
    this.gifPickerOpen.set(false);
    this.pickerOpen.set(!this.pickerOpen());
  }

  /** Toggle the GIF grid, closing the other overlays (only one at a time). */
  toggleGifPicker(): void {
    this.pickerOpen.set(false);
    this.gifPickerOpen.set(!this.gifPickerOpen());
  }

  /** Begin recording a voice message; toasts and resets if the mic is unavailable. */
  async startVoiceRecording(): Promise<void> {
    // Guard re-entry: `recordingVoice` isn't set until the async mic acquisition
    // resolves, so a second click before then would open a second mic stream and
    // orphan the first. `voiceStarting` closes that window synchronously.
    if (this.recordingVoice() || this.voiceStarting) {
      return;
    }
    this.voiceStarting = true;
    const roomAtStart = this.roomId();
    try {
      await this.voiceRecorder.start();
    } catch {
      this.voiceStarting = false;
      this.toast.show('Could not access the microphone.', {
        duration: 4000,
        variant: 'destructive',
      });
      return;
    }
    this.voiceStarting = false;
    // The view may have been torn down, or the room switched, during acquisition —
    // don't leave a stream open / timer ticking (and never bind the clip to a room
    // the user has since left).
    if (this.destroyed || this.roomId() !== roomAtStart) {
      this.voiceRecorder.cancel();
      return;
    }
    this.recordingVoice.set(true);
    this.voiceElapsed.set(0);
    this.voiceTimer = setInterval(
      () => this.voiceElapsed.update((s) => s + 1),
      1000,
    );
  }

  /** Stop recording and send the clip as a voice message. */
  stopVoiceRecording(): void {
    if (!this.recordingVoice()) {
      return;
    }
    this.clearVoiceTimer();
    this.recordingVoice.set(false);
    void this.voiceRecorder.stop().then((recording) => {
      if (!recording || recording.blob.size === 0) {
        return;
      }
      // A voice message is standalone; drop any active reply (as media does).
      if (this.replyingTo()) {
        this.cancelReply.emit();
      }
      this.timeline
        .sendVoiceMessage(recording)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          error: () =>
            this.toast.show('Could not send that voice message.', {
              duration: 4000,
              variant: 'destructive',
            }),
        });
    });
  }

  /** Abort the recording, discarding the clip. */
  cancelVoiceRecording(): void {
    if (!this.recordingVoice()) {
      return;
    }
    this.clearVoiceTimer();
    this.recordingVoice.set(false);
    this.voiceRecorder.cancel();
  }

  private clearVoiceTimer(): void {
    if (this.voiceTimer !== null) {
      clearInterval(this.voiceTimer);
      this.voiceTimer = null;
    }
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
    if (this.mentionOpen()) {
      this.mentionQuery.set(null);
      return;
    }
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
    if (this.mentionOpen()) {
      event.preventDefault();
      this.moveMentionSelection(-1);
      return;
    }
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
