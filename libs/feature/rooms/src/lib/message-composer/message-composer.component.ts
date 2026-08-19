import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TrnTextarea } from '@trinity/components/textarea';
import { TrnTooltip } from '@trinity/components/tooltip';
import {
  ComposerSettingsService,
  DraftStoreService,
  KeyboardShortcutsService,
} from '@trinity/platform-native';
import { type GifResult } from '@trinity/data-access/gif';
import {
  applyFormat,
  continueList,
  escapeHtml,
  linkifyText,
  renderMarkdown,
  sanitizeMatrixHtml,
  slashCommandContent,
  textMessageContent,
  type EditResult,
  type FormatAction,
  type Mention,
} from '@trinity/util/matrix';
import { BELOW_MD_QUERY, mediaQuerySignal } from '@trinity/util/ui';
import { ComposerToolbarComponent } from './composer-toolbar/composer-toolbar.component';
import { ComposerAttachmentStripComponent } from './composer-attachment-strip/composer-attachment-strip.component';
import { ComposerInsertMenuComponent } from './composer-insert-menu/composer-insert-menu.component';
import { ComposerSuggestionsComponent } from './composer-suggestions/composer-suggestions.component';
import { SpoilerRevealDirective } from '../spoiler/spoiler-reveal.directive';
import { MatrixLinkDirective } from '../matrix-link/matrix-link.directive';
import { GifPickerComponent } from '../gif-picker/gif-picker.component';
import { ComposerAttachmentsService } from './composer-attachments.service';
import {
  type BatchItem,
  type BatchOutcome,
  type BatchProgress,
} from '../shared/send-media-batch';
import { EmojiAutocomplete } from './emoji-autocomplete';
import { TrnIconComponent } from '@trinity/components/icon';
import {
  TrnEmojiIndex,
  TrnEmojiPickerComponent,
  type TrnEmojiPick,
} from '@trinity/components/emoji-picker';
import {
  MentionAutocomplete,
  type MentionMember,
} from './mention-autocomplete';

/**
 * A room member offered by the @-mention autocomplete. Re-exported here because it is the
 * shape of this component's `members` input; the list itself lives with the engine.
 */
export type { MentionMember };

/** What the composer emits on submit: the message text plus any @-mentioned users. */
export interface ComposerSubmit {
  text: string;
  mentions: Mention[];
}

const MAX_HEIGHT_PX = 200;

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

/** Instance counter behind {@link MessageComposerComponent.pickerId}. */
let nextPickerId = 0;

/**
 * Discord-style composer: Enter sends, Shift+Enter inserts a newline. In edit mode
 * it is prefilled with the message draft and Esc cancels. An emoji button opens a
 * picker that inserts at the cursor.
 *
 * What it owns is the textarea: its value, its caret, the draft behind it and what a submit
 * makes of them. The two autocompletes ({@link EmojiAutocomplete}, {@link MentionAutocomplete})
 * and every non-text attachment ({@link ComposerAttachmentsService}) live beside it, and the
 * template's four child components render what they hold.
 */
@Component({
  selector: 'trn-message-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TrnIconComponent,
    TrnTooltip,
    TrnTextarea,
    TrnEmojiPickerComponent,
    GifPickerComponent,
    ComposerToolbarComponent,
    ComposerAttachmentStripComponent,
    ComposerInsertMenuComponent,
    ComposerSuggestionsComponent,
    SpoilerRevealDirective,
    MatrixLinkDirective,
  ],
  // Per composer instance, not per app: the room composer and the thread composer are alive
  // at once and each needs its own staged file, GIF grid and recording.
  providers: [ComposerAttachmentsService],
  // Escape is handled at the host, not on the textarea, because the pickers it
  // dismisses can be opened without the textarea ever holding focus — pick GIF from the
  // insert tray on a narrow layout and CDK restores focus to the `+` trigger. The
  // pickers render inside this component, so the keystroke reaches here from anywhere in
  // the composer. Bound once: a second binding on the textarea would double-fire and
  // close two things per press.
  host: { '(keydown.escape)': 'onEscape()' },
  templateUrl: './message-composer.component.html',
  styleUrl: './message-composer.component.scss',
})
export class MessageComposerComponent {
  /**
   * Unique per instance, because two composers are routinely alive at once: the room's own
   * and the thread panel's. A shared literal put the same `id` on both open panels and left
   * the trigger's `aria-controls` resolving to whichever the document reached first — the
   * failure ARIA is least able to report, since the attribute is present and points at a
   * real element either way.
   */
  protected readonly pickerId = `composer-emoji-picker-${nextPickerId++}`;

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
  readonly members = input<readonly MentionMember[]>([]);
  /**
   * Whether to offer the room-scoped rich actions (poll, location, voice).
   * These act on the *active room* via their own services, so they can't be routed
   * into a thread — the thread composer sets this false to hide them.
   */
  readonly richActions = input(true);
  /** Upload fraction in [0, 1] while an attachment uploads, else null (idle). */
  readonly uploadProgress = input<BatchProgress | null>(null);
  readonly submitText = output<ComposerSubmit>();
  /**
   * A batch caption, to be posted as its own message.
   *
   * Separate from {@link submitText} because that one is routed by the composer's CURRENT
   * edit/reply state, and this text was written before an upload that can take minutes. By the
   * time it lands the user may be editing something else — and routing it then would apply the
   * caption as that edit, rewriting a message already in the room.
   */
  readonly submitBatchCaption = output<ComposerSubmit>();
  /** A staged attachment plus its optional caption, emitted on submit. */
  /**
   * Send these files, in this order, as N events.
   *
   * `onOutcomes` rather than a return value because an `output` cannot have one, and the
   * composer has to learn which items failed: those stay staged so they can be retried,
   * which is the whole reason the batch reports per-item rather than throwing.
   *
   * The host MUST call it when the batch settles — it also releases the one-at-a-time send
   * latch, and being told is the point. Deriving that from `uploadProgress` is what broke
   * before: a send can finish before the host's progress is ever observable, and a signal
   * input, written only at change detection and skipped entirely when the value is
   * `Object.is`-equal, never sees it move at all.
   */
  readonly submitMedia = output<{
    items: readonly BatchItem[];
    caption: string;
    onOutcomes: (outcomes: readonly BatchOutcome[]) => void;
  }>();
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

  /**
   * True on the narrow single-pane layout, where the toolbar keeps fewer buttons outside its
   * overflow. Owned here rather than in the toolbar so that stays presentational, the same
   * division the sidebar's user panel uses.
   */
  protected readonly narrowLayout = mediaQuerySignal(
    BELOW_MD_QUERY,
    inject(DestroyRef),
  );

  /** Whether the preview is showing in place of the input. */
  readonly previewing = signal(false);

  /**
   * The message as it will arrive, rendered through the timeline's own path so the two cannot
   * disagree — including the slash commands wherever the send path parses them, because
   * `/spoiler x` sends a concealed span and previewing the literal text would be a lie in
   * exactly the case a preview is most useful. Where it does not parse them (reply, edit,
   * caption) the lie runs the other way, so the preview shows the text as typed.
   *
   * `sanitizeMatrixHtml` is what adds the render-only normalisation the send path deliberately
   * omits: the spoiler class the reveal directive needs, the code-block language caption and
   * syntax highlighting.
   */
  readonly preview = computed<{ html: string; rich: boolean }>(() => {
    const text = this.text().trim();
    if (!text) {
      return { html: '', rich: false };
    }
    const mentions = untracked(() => this.activeMentions());
    // Slash commands only where they are actually parsed on send:
    // `TimelineActionsService.send` and `ThreadsService.sendThreadMessage`. A reply,
    // an edit and an attachment caption route through `replyMessageContent` /
    // `editMessageContent` / `mediaCaptionFields`, none of which look at a leading
    // slash — so previewing `/spoiler x` concealed while replying would promise a
    // spoiler and send the literal text.
    const parsesCommands =
      !this.editing() && !this.replyingTo() && !this.hasStaged();
    const content = ((parsesCommands
      ? slashCommandContent(text, renderMarkdown, mentions)
      : null) ?? textMessageContent(text, renderMarkdown(text), mentions)) as {
      formatted_body?: string;
      body?: string;
    };
    const html = content.formatted_body;
    if (html) {
      return { html: sanitizeMatrixHtml(html), rich: true };
    }
    // No formatted_body means it goes as plain text, which the timeline linkifies (falling
    // back to the raw body when there is no URL) — mirror both, including which container it
    // lands in. `linkifyText` replaces newlines with `<br>`, so its output belongs in the
    // rendered-markdown container the timeline uses at `message-row.component.html:88`;
    // without that class the link would render browser-blue instead of in the palette.
    // The fallback keeps raw newlines and so needs `pre-wrap`, which is what `rich: false`
    // selects — hence `escapeHtml` and NOT `escapeInlineText`, whose `<br>`s would double
    // every line break under it.
    const body = content.body ?? text;
    const linkified = linkifyText(body);
    return linkified !== null
      ? { html: linkified, rich: true }
      : { html: escapeHtml(body), rich: false };
  });

  /**
   * Every way something other than typed text gets into the message: a picked, pasted or
   * dropped-in file, a GIF, a poll, a location, a voice clip. The signals and methods below
   * that carry an attachment meaning are this service's, surfaced under their long-standing
   * names so the template and the consumers of this component see one composer.
   */
  private readonly attachments = inject(ComposerAttachmentsService);

  /** Everything staged for the next submit, in the order it will be sent. */
  readonly staged = this.attachments.staged;
  /** Whether anything is staged. */
  readonly hasStaged = this.attachments.hasStaged;
  readonly pickerOpen = signal(false);
  /** Whether the GIF search grid is open (mutually exclusive with the emoji picker). */
  readonly gifPickerOpen = this.attachments.gifPickerOpen;
  /** True while a voice message is being recorded. */
  readonly recordingVoice = this.attachments.recordingVoice;
  /** `m:ss` label for the running recording timer. */
  readonly voiceTimeLabel = this.attachments.voiceTimeLabel;
  /** True while a chosen GIF is being fetched, before its media upload starts. */
  readonly gifDownloading = this.attachments.gifDownloading;
  /** The GIF affordance is offered only once a provider + API key are configured. */
  readonly gifEnabled = this.attachments.gifEnabled;
  /** True while a location is being resolved and sent (drives the button's busy state). */
  readonly locationSharing = this.attachments.locationSharing;
  /**
   * Whether the narrow-layout `+` opens the insert tray rather than the file picker
   * directly. With only one insert action left to offer — the thread composer with no
   * GIF provider configured — a one-item menu is pure friction, so `+` stays a plain
   * attach button there. See the media query in the SCSS for where the tray applies.
   */
  readonly hasInsertMenu = computed(
    () => this.richActions() || this.gifEnabled(),
  );
  /**
   * The two autocomplete engines. Each owns its trigger detection, suggestion list,
   * highlighted index and the caret splice an acceptance resolves to; this component owns
   * the textarea, so it reads the caret, hands it over, and applies whatever comes back.
   * That is the boundary the two used to lack — they shared one caret model in-line here.
   */
  private readonly emojiAutocomplete = new EmojiAutocomplete(
    inject(TrnEmojiIndex),
  );
  private readonly mentionAutocomplete = new MentionAutocomplete(this.members);
  /** The `:shortcode` fragment under the caret, or null when the menu is closed. */
  readonly emojiQuery = this.emojiAutocomplete.query;
  /** Ranked emoji suggestions for the current query (from emoji-mart's index). */
  readonly emojiMatches = this.emojiAutocomplete.matches;
  /** The menu is shown only when a query yields at least one match. */
  readonly emojiOpen = this.emojiAutocomplete.open;
  /** Index of the highlighted suggestion. */
  readonly emojiActiveIndex = this.emojiAutocomplete.activeIndex;
  /** The `@mention` query under the caret, or null when the menu is closed. */
  readonly mentionQuery = this.mentionAutocomplete.query;
  /** Members matching the current query (prefix matches first), capped for the menu. */
  readonly mentionMatches = this.mentionAutocomplete.matches;
  /** The mention menu shows only when a query yields at least one member. */
  readonly mentionOpen = this.mentionAutocomplete.open;
  /** Index of the highlighted member suggestion. */
  readonly mentionActiveIndex = this.mentionAutocomplete.activeIndex;
  /**
   * The file the visible upload belongs to.
   *
   * The bar renders above the rows that are still staged, and without this it reads as though
   * it describes them — it describes the one that just left the list. Written in the host's
   * `sendMedia` hook rather than in `submit()`, because that hook is the single funnel every
   * upload passes through: a GIF goes straight to it and never touches `submit()`, and naming
   * the last *staged* file while a GIF uploads is worse than not naming anything.
   */
  private readonly sendingItems = signal<readonly BatchItem[]>([]);
  /**
   * The name of the file currently uploading, taken from the batch's own position rather than
   * remembered separately — so it follows the batch through file 2, 3, … instead of naming
   * whatever was dispatched first.
   */
  readonly uploadLabel = computed(() => {
    const progress = this.uploadProgress();
    return progress
      ? (this.sendingItems()[progress.index - 1]?.file.name ?? null)
      : null;
  });
  /**
   * A media send has been dispatched and its upload has not finished.
   *
   * Separate from `uploadProgress` and written SYNCHRONOUSLY, which is the whole point:
   * `uploadProgress` is a signal input fed from two component layers up, and a signal input
   * is only written during the parent's change detection — which, zoneless, is scheduled on a
   * rAF/timer race. Two `submit()` calls in one task (a held Enter key, while the first send's
   * `encryptAttachment` janks the frame) would both read `null` and both dispatch. A local
   * flag closes in the same statement that opens it, and is released by the `done` callback
   * the host calls when the send settles.
   */
  private readonly sendingMedia = signal(false);
  /**
   * Whether a media send would be accepted right now — the same condition `dispatchMedia`
   * enforces, exposed so the send button can SAY it is blocked rather than silently doing
   * nothing. `sendingMedia` matters here and not just `uploadProgress`: the latch closes
   * synchronously, while the input it mirrors lags by a change-detection tick.
   */
  protected readonly canSendMedia = computed(
    () => this.uploadProgress() === null && !this.sendingMedia(),
  );
  private readonly textarea = viewChild<ElementRef<HTMLTextAreaElement>>('ta');
  private readonly fileInput =
    viewChild<ElementRef<HTMLInputElement>>('fileInput');
  private readonly injector = inject(Injector);

  /** Whether this device can record voice (mic + MediaRecorder present). */
  get voiceSupported(): boolean {
    return this.attachments.voiceSupported;
  }
  private readonly drafts = inject(DraftStoreService);
  private readonly composerSettings = inject(ComposerSettingsService);
  /**
   * Whether the formatting toolbar is shown (Settings → Appearance). Hiding it is a screen
   * space choice, so it takes away the ROW only: {@link onKeydown} still resolves the
   * formatting chords, and Shift+Enter still continues a list.
   */
  readonly showToolbar = this.composerSettings.showFormattingToolbar;
  /** Resolves the user's (rebindable) formatting chords — see {@link onKeydown}. */
  private readonly shortcuts = inject(KeyboardShortcutsService);
  private wasEditing = false;
  private wasEditTargetId: string | null = null;
  private wasReplying = false;

  private wasRoomId: string | null | undefined = undefined;

  constructor() {
    // Before anything else: the attachment workflows call straight back through this, and
    // the room-change effect below can already ask them to drop a staged file.
    this.attachments.connect({
      roomId: this.roomId,
      editing: this.editing,
      uploadProgress: this.uploadProgress,
      sendMedia: (file, caption) => {
        // A GIF is a one-item batch with a synthetic id: it was never staged, so nothing in
        // the strip has to be reconciled when its outcome lands.
        this.dispatchMedia([{ id: `direct-${file.name}`, file }], caption, []);
      },
      endReply: () => {
        if (this.replyingTo()) {
          this.cancelReply.emit();
        }
      },
      focusInput: () =>
        queueMicrotask(() => this.textarea()?.nativeElement.focus()),
      leavePreview: () => this.previewing.set(false),
      openFileDialog: () => this.fileInput()?.nativeElement.click(),
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
          this.clearStaged();
          // The upload itself belongs to the page, not to this composer, and survives the
          // switch — but nothing staged here does, so holding the latch would only mute the
          // next room's composer.
          this.sendingMedia.set(false);
          // A recording belongs to the room it was started in — cancel it on a
          // room/thread switch so the mic doesn't stay open and a later Send can't
          // post the clip to the wrong room.
          if (this.recordingVoice()) {
            this.cancelVoiceRecording();
          }
          this.mentionAutocomplete.clearChosen(); // they belong to the old conversation
          this.previewing.set(false); // the new room opens ready to write, not to read
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

    // The preview toggle lives ON the toolbar, so taking the toolbar away mid-preview would
    // leave the composer showing a preview with nothing left to switch back — the same trap
    // `resetMenus` guards against, arriving from Settings rather than from a send.
    effect(() => {
      if (!this.showToolbar()) {
        this.previewing.set(false);
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
        // A preview hides the textarea, so the focus() below would land on nothing and
        // leave the composer swallowing every keystroke of the reply being typed.
        this.previewing.set(false);
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
        // Both branches replace the text wholesale, so a preview left open would be showing
        // content that is no longer there — and the focus() below cannot land on a hidden
        // textarea, leaving edit mode apparently unresponsive.
        this.previewing.set(false);
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
        this.previewing.set(false);
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

    const hit = this.shortcuts.resolve(keyEvent);
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
    const el = this.textarea()?.nativeElement;
    const caret = el?.selectionStart ?? this.text().length;
    // Only meaningful for a collapsed caret: with a selection, Shift+Enter replaces it, which
    // is the browser's job.
    if (el && el.selectionStart !== el.selectionEnd) {
      return;
    }
    const result = continueList(this.text(), caret);
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
    // still true here — the input only changes on the next change detection. The effect
    // above then takes its `!editing && wasEditing` branch and does an unconditional
    // `text.set(draft)`, which would land AFTER this insert and silently discard the
    // quote. afterNextRender runs after that effect, so the quote survives.
    //
    // afterNextRender, NOT queueMicrotask: the app is zoneless, so the host's signal write
    // only schedules change detection (rAF) and a microtask would still run before the
    // effect. Same reason `onTogglePreview` uses it.
    if (this.editing()) {
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
    this.previewing.set(false);
    const existing = this.text();
    const text = existing ? block + existing : block;
    this.applyEdit({
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
  }

  /** Apply a formatting action to the current selection. */
  onFormat(action: FormatAction): void {
    const el = this.textarea()?.nativeElement;
    const value = this.text();
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    this.applyEdit(applyFormat(value, start, end, action));
  }

  /**
   * Adopt an edit's text and selection.
   *
   * The DOM is written synchronously as well as the signal. These edits replace a keystroke we
   * cancelled — Shift+Enter's newline, a formatting chord — so the textarea has to show the
   * result before the *next* keystroke arrives. Leaving it to change detection opens a window
   * in which a fast typist's next character is read back off a stale value and the edit is
   * silently undone. The selection is re-asserted in a microtask as well, because Angular's own
   * `[value]` write lands somewhere in there and setting `value` resets the caret to the end.
   */
  private applyEdit(result: EditResult): void {
    this.text.set(result.text);
    const el = this.textarea()?.nativeElement;
    if (el) {
      el.value = result.text;
      el.setSelectionRange(result.selectionStart, result.selectionEnd);
    }
    this.autoGrow();
    // The same bookkeeping a keystroke would have done. Without it an open mention menu keeps
    // a query anchored to a caret that has moved — accepting it then splices at a stale offset
    // — and a message begun entirely from the toolbar never announces that anyone is typing.
    this.syncEmojiAutocomplete();
    this.syncMentionAutocomplete();
    this.typing.emit(result.text.trim().length > 0);
    queueMicrotask(() => {
      const settled = this.textarea()?.nativeElement;
      settled?.focus();
      settled?.setSelectionRange(result.selectionStart, result.selectionEnd);
      this.autoGrow();
    });
  }

  /** Swap between writing and previewing, returning focus to the input on the way back. */
  onTogglePreview(): void {
    const next = !this.previewing();
    this.previewing.set(next);
    if (!next) {
      // afterNextRender, NOT queueMicrotask: the app is zoneless, so setting the signal only
      // schedules change detection (rAF). A microtask runs first, while the textarea is still
      // `display: none` — and focus() on a hidden element is a no-op, so the caret would end
      // up on <body> and the next keystroke would go nowhere.
      afterNextRender(() => this.textarea()?.nativeElement?.focus(), {
        injector: this.injector,
      });
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
    const batch = this.editing() ? [] : this.staged();
    if (batch.length) {
      // Emptied BEFORE the dispatch, not after. A send can settle synchronously — a 0-byte
      // file never reaches the network — and `onBatchOutcomes` gives the caption back when
      // nothing carried it, so clearing afterwards would wipe what it had just restored.
      const typed = this.text();
      this.text.set('');
      // One batch at a time — the check lives in `dispatchMedia`, so every route to a send is
      // covered rather than just this one. Nothing below runs when it refuses: a blocked send
      // must not clear the composer as though it had gone out.
      if (
        !this.dispatchMedia(
          batch.map(({ id, file }) => ({ id, file })),
          typed.trim(),
          this.activeMentions(),
        )
      ) {
        this.text.set(typed); // refused, so nothing went out and nothing was cleared
        return;
      }
      // A media send carries no reply relation, so end any active reply — else
      // the banner lingers and the next plain message silently replies to a
      // now-stale target.
      if (this.replyingTo()) {
        this.cancelReply.emit();
      }
      // The staged rows stay until their outcomes arrive: the ones that fail have to remain
      // so they can be retried, which is the whole point of the batch reporting per item.
      this.resetMenus();
      this.regrowAfterRender();
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
      this.regrowAfterRender();
    }
  }

  /**
   * Re-measure the input once the DOM reflects the signals just written.
   *
   * `afterNextRender`, NOT `queueMicrotask`, for the reason {@link onTogglePreview} records:
   * this runs in an event handler, where the app being zoneless means a signal write only
   * schedules change detection (a rAF/timeout race) — a microtask beats it. `resetMenus`
   * leaves the preview, so the microtask measured a textarea still `display: none`,
   * `scrollHeight` read 0, and the input was pinned to `height: 0px` (it has `min-height: 0`
   * and `box-sizing: border-box`) until the next keystroke grew it again. Not reachable by a
   * unit test: jsdom reports `scrollHeight: 0` for everything.
   */
  private regrowAfterRender(): void {
    afterNextRender(() => this.autoGrow(), { injector: this.injector });
  }

  /** Close both autocomplete menus and forget the tracked mentions. */
  private resetMenus(): void {
    this.emojiQuery.set(null);
    this.mentionQuery.set(null);
    this.mentionAutocomplete.clearChosen();
    // A grid left open across a send is the one remaining route to two uploads at once: its
    // items call `sendMedia` directly, and unlike the toolbar button they are not disabled
    // while an upload runs. `dispatchMedia` refuses it either way; closing the grid means the
    // user does not lose a chosen GIF to that refusal.
    this.gifPickerOpen.set(false);
    // Leaving the preview on is a trap rather than a preference: it hides the textarea, so a
    // composer that lands in preview mode after a send or a room switch looks broken — an
    // empty box that swallows typing until you notice the eye button.
    this.previewing.set(false);
  }

  /** Caret offset in the textarea, or the end of the text when it isn't rendered. */
  private caret(): number {
    return this.textarea()?.nativeElement.selectionStart ?? this.text().length;
  }

  /** Recompute the mention menu from the `@query` under the caret. */
  private syncMentionAutocomplete(): void {
    this.mentionAutocomplete.sync(this.text(), this.caret());
  }

  /** Accept a member: swap the `@query` for `@Name ` and record the mention. */
  acceptMention(index = this.mentionActiveIndex()): void {
    const replacement = this.mentionAutocomplete.accept(
      this.text(),
      this.caret(),
      index,
    );
    if (!replacement) {
      return;
    }
    this.replaceRange(replacement.start, replacement.end, replacement.insert);
    this.mentionQuery.set(null);
  }

  private moveMentionSelection(delta: number): void {
    const next = this.mentionAutocomplete.move(delta);
    if (next !== null) {
      this.scrollSuggestionIntoView(`mention-suggestion-${next}`);
    }
  }

  /** Chosen mentions still present in the text (deleted ones dropped), deduped. */
  private activeMentions(): Mention[] {
    return this.mentionAutocomplete.active(this.text());
  }

  /**
   * Recompute the emoji menu from the text before the caret, applying the inline
   * `:shortcode:` → emoji replacement the engine resolves when one is complete.
   */
  private syncEmojiAutocomplete(): void {
    const replacement = this.emojiAutocomplete.sync(this.text(), this.caret());
    if (replacement) {
      this.replaceRange(replacement.start, replacement.end, replacement.insert);
    }
  }

  /** The emoji picker chose an emoji → insert its native character at the cursor. */
  onPickerSelect(pick: TrnEmojiPick): void {
    // No emptiness check: the wrapper drops picks with no character, so anything that
    // arrives here is insertable. This used to no-op silently on such an event.
    this.insertEmoji(pick.native);
  }

  /** Open the create-poll dialog (starts a poll in the active room on confirm). */
  openPollDialog(): void {
    this.attachments.openPollDialog();
  }

  /** Share the device's current location to the active room. */
  shareLocation(): void {
    this.attachments.shareLocation();
  }

  /** Toggle the emoji picker, closing the other overlays (only one at a time). */
  toggleEmojiPicker(): void {
    this.gifPickerOpen.set(false);
    this.pickerOpen.set(!this.pickerOpen());
  }

  /** Toggle the GIF grid, closing the other overlays (only one at a time). */
  toggleGifPicker(): void {
    this.pickerOpen.set(false);
    this.attachments.toggleGifPicker();
  }

  /** Begin recording a voice message; toasts and resets if the mic is unavailable. */
  startVoiceRecording(): Promise<void> {
    return this.attachments.startVoiceRecording();
  }

  /** Stop recording and send the clip as a voice message. */
  stopVoiceRecording(): void {
    this.attachments.stopVoiceRecording();
  }

  /** Abort the recording, discarding the clip. */
  cancelVoiceRecording(): void {
    this.attachments.cancelVoiceRecording();
  }

  /** A GIF was chosen → download it and send it through the media path. */
  onGifSelect(gif: GifResult): void {
    this.attachments.gifSelected(gif);
  }

  /** Accept a suggestion: swap the `:fragment` under the caret for the emoji. */
  acceptEmoji(index = this.emojiActiveIndex()): void {
    const acceptance = this.emojiAutocomplete.accept(
      this.text(),
      this.caret(),
      index,
    );
    if (!acceptance) {
      return;
    }
    if (acceptance.kind === 'replace') {
      const { start, end, insert } = acceptance.replacement;
      this.replaceRange(start, end, insert);
    } else {
      // Caret drifted off the fragment — fall back to a plain cursor insert.
      this.insertEmoji(acceptance.native);
    }
    this.emojiQuery.set(null);
  }

  private moveEmojiSelection(delta: number): void {
    const next = this.emojiAutocomplete.move(delta);
    if (next !== null) {
      this.scrollSuggestionIntoView(`emoji-suggestion-${next}`);
    }
  }

  /**
   * Keep the highlighted option in view: `aria-activedescendant` doesn't auto-scroll the
   * listbox, and the result set can overflow the menu's max-height. `id` must be the one
   * `ComposerSuggestionsComponent` stamps on the option — the same id
   * `aria-activedescendant` points at.
   */
  private scrollSuggestionIntoView(id: string): void {
    queueMicrotask(() =>
      document.getElementById(id)?.scrollIntoView?.({ block: 'nearest' }),
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
    this.attachments.attach();
  }

  /** Hidden file input change → stage the picked file, then reset for re-picking. */
  onFilePicked(event: Event): void {
    this.attachments.filePicked(event);
  }

  /**
   * The single funnel every media send passes through: `submit()` for the staged batch, and
   * the attachments service's `sendMedia` hook for a GIF. The in-flight list, the send latch
   * and the one-at-a-time check all live here, so a path that does not go through `submit()`
   * cannot miss any of them.
   *
   * Returns whether the batch was dispatched, so a caller with cleanup to do — `submit()`
   * clears the text — can tell a refusal from a send.
   */
  private dispatchMedia(
    items: readonly BatchItem[],
    caption: string,
    mentions: readonly Mention[],
  ): boolean {
    if (!items.length) {
      return false;
    }
    // Guarded here rather than only on the send button, because `onEnter` calls `submit()`
    // directly and never consults `[disabled]` — key auto-repeat alone is enough to fire it
    // twice. Two batches in flight share one `uploadProgress` and interleave their events, so
    // neither arrives in the order it was staged.
    if (this.uploadProgress() !== null || this.sendingMedia()) {
      return false;
    }
    this.sendingItems.set(items);
    this.sendingMedia.set(true);
    // Stamped with the room, like the files themselves are by the owner: a batch settles long
    // after it was pressed, and by then this composer may be showing a different conversation.
    const roomAtDispatch = this.roomId();
    this.submitMedia.emit({
      items,
      caption,
      onOutcomes: (outcomes) =>
        this.onBatchOutcomes(outcomes, caption, mentions, roomAtDispatch),
    });
    return true;
  }

  /**
   * What survives a batch: successes leave the strip, failures stay in it so the next send
   * retries exactly them. A caption typed for a batch goes out as its own message afterwards
   * — Matrix has no multi-attachment event, so there is no first image for it to belong to,
   * and repeating it on each would put the same sentence in the room N times. A single file
   * keeps its MSC2530 caption, which is what `sendMediaBatch` decides.
   */
  private onBatchOutcomes(
    outcomes: readonly BatchOutcome[],
    caption: string,
    mentions: readonly Mention[],
    roomAtDispatch: string | null,
  ): void {
    // The batch is over the moment its outcomes land, and this is the ONLY release: inferring
    // it from `uploadProgress` returning to null cannot work, because a send that completes
    // synchronously is back to null before a signal input can ever observe it move.
    this.sendingMedia.set(false);
    for (const outcome of outcomes) {
      if (!outcome.failed) {
        this.attachments.removeStaged(outcome.id);
      }
    }
    // A staged file and a failed one look identical in the strip, so mark them rather than
    // leaving the user to guess. Only this batch's failures — these outcomes say nothing
    // about files that failed in an earlier round and have not been retried yet.
    this.attachments.markFailed(
      outcomes.filter((outcome) => outcome.failed).map((outcome) => outcome.id),
    );
    if (!caption) {
      return;
    }
    if (this.roomId() !== roomAtDispatch) {
      // The conversation moved on. Posting would put these words in a room they were not
      // written for, and restoring would leave them in that room's composer — the same leak
      // the room-change effect above exists to prevent. Parked as the draft of the room they
      // belong to instead, so they are neither misdelivered nor destroyed.
      if (roomAtDispatch != null && !this.drafts.get(roomAtDispatch)) {
        this.drafts.set(roomAtDispatch, caption);
      }
      return;
    }
    const delivered = outcomes.filter((outcome) => !outcome.failed).length;
    if (delivered && outcomes.length > 1) {
      // No file for a batch caption to belong to, so it goes out on its own — after the
      // files, and only if at least one of them actually arrived. On its OWN output: by now
      // the user may be part-way into an edit or a reply, and the ordinary submit path would
      // route this into it.
      this.submitBatchCaption.emit({ text: caption, mentions: [...mentions] });
      return;
    }
    if (!delivered && !this.text().trim()) {
      // Nothing carried it: a single file's caption rides its media event (MSC2530) and went
      // down with it, and a batch caption is never sent when the batch delivered nothing.
      // `submit()` cleared the box on dispatch, so without this the words are simply gone.
      // Skipped when something has been typed since — restoring is for what was lost, not
      // for overwriting what replaced it.
      this.text.set(caption);
      this.regrowAfterRender();
    }
  }

  /**
   * Re-send one failed file on its own, leaving the rest of the batch staged.
   *
   * Pressing send again would also retry it — that is what the batch model gives you for
   * free — but it retries *everything* staged, which is wrong when only one of five failed
   * and the other four are files the user has since added.
   */
  protected retryStaged(id: string): void {
    const attachment = this.attachments
      .staged()
      .find((candidate) => candidate.id === id);
    if (!attachment) {
      return;
    }
    // The one-at-a-time check is repeated here rather than left to `dispatchMedia`, because
    // the flag is cleared BEFORE dispatching — a refusal would otherwise leave the row
    // looking like it had been sent.
    if (this.uploadProgress() !== null || this.sendingMedia()) {
      return;
    }
    // So the row reads as uploading rather than as still-failed. Only this one: the others
    // are still failed and have not been retried.
    this.attachments.clearFailed([id]);
    // Clearing the flag unmounts the row's retry button — the element that currently has
    // focus — which would strand a keyboard user at the top of the page. Same remedy, and the
    // same reason, as `removeStaged`.
    queueMicrotask(() => this.textarea()?.nativeElement.focus());
    // A retry is a send: it takes whatever caption is in the box and clears it the way
    // `submit()` does, before dispatching and for the same reason.
    const typed = this.text();
    this.text.set('');
    if (
      !this.dispatchMedia(
        [{ id: attachment.id, file: attachment.file }],
        typed.trim(),
        this.activeMentions(),
      )
    ) {
      this.text.set(typed);
    }
  }

  /** Drop the staged attachment (× button, Escape, or after it's sent). */
  removeStaged(id: string): void {
    this.attachments.removeStaged(id);
    // Whatever removed the row — its × or a send — the element that had focus is about to be
    // destroyed, which drops focus to <body> and strands a keyboard user at the top of the
    // page. The textarea is where they were heading either way. Queued, like the staging
    // path's own focus call: the row is still in the DOM until CD runs.
    queueMicrotask(() => this.textarea()?.nativeElement.focus());
  }

  /**
   * Stage files that came from outside the composer — today, a drop on the conversation.
   *
   * Public because the drop target is the whole room, which the message list owns; the
   * refusal rules stay here so a drop cannot bypass what a paste respects.
   */
  stageFiles(files: readonly File[]): void {
    this.attachments.stageExternal(files);
  }

  /** Drop every staged attachment. */
  clearStaged(): void {
    this.attachments.clearStaged();
  }

  /** Paste an image from the clipboard → stage it as an attachment (Discord-style). */
  onPaste(event: ClipboardEvent): void {
    this.attachments.paste(event);
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
    // Not while a batch is going out: those rows are what its outcomes will report on, and
    // clearing them means a failure has nowhere to land — the toast would then promise files
    // are "still in the composer" that are not.
    if (this.hasStaged() && !this.sendingMedia()) {
      this.clearStaged();
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
    if (this.editing() || this.text().length > 0 || this.hasStaged()) {
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
