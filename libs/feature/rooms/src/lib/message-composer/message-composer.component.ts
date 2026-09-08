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
  type Signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnIconButton } from '@trinity/components/controls';
import { TrnTooltip } from '@trinity/components/generic-content';
import {
  DraftStoreService,
  KeyboardShortcutsService,
} from '@trinity/platform-native';
import { type GifResult } from '@trinity/data-access/gif';
import type { ImagePack, ImagePackImage } from '@trinity/data-access/media';
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
import { ComposerFormatMenuComponent } from './composer-format-menu/composer-format-menu.component';
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
import { ComposerTextField } from './composer-text-field';
import { ComposerBatchSender } from './composer-batch-sender';
import { ComposerAutocompletes } from './composer-autocompletes';
import { TrnIconComponent } from '@trinity/components/foundations';
import { TrnAnchoredOverlayDirective } from '@trinity/components/overlay';
import {
  TrnEmojiIndex,
  TrnEmojiPickerComponent,
  type TrnEmojiPick,
} from '@trinity/components/controls';
import { type MentionMember } from './mention-autocomplete';
import { StickerPickerComponent } from '../sticker-picker/sticker-picker.component';
import { InlineMxcImagesDirective } from '../inline-mxc-images/inline-mxc-images.directive';
import { WorkspaceApplicationSurfaceService } from '@trinity/application/workspace';

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
    TrnIconButton,
    TrnIconComponent,
    TrnTooltip,
    TrnEmojiPickerComponent,
    GifPickerComponent,
    StickerPickerComponent,
    InlineMxcImagesDirective,
    ComposerFormatMenuComponent,
    ComposerAttachmentStripComponent,
    ComposerInsertMenuComponent,
    ComposerSuggestionsComponent,
    TrnAnchoredOverlayDirective,
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
  private readonly applicationSurfaces = inject(
    WorkspaceApplicationSurfaceService,
  );
  private readonly destroyRef = inject(DestroyRef);
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
   * Conversation-owned compose draft. Null keeps the legacy thread-local persistence path
   * until thread state moves behind its Conversation child in the dedicated thread slice.
   */
  readonly composeDraft = input<string | null>(null);
  /** A Conversation-owned text attempt is still resolving through the SDK. */
  readonly textSending = input(false);
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
  /** Account identity distinguishes two Conversations in the same Matrix Room. */
  readonly accountId = input<string | null>(null);
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
  /** MSC2545 packs available to this room. Empty in thread composers. */
  readonly stickerPacks = input<readonly ImagePack[]>([]);
  /** Upload fraction in [0, 1] while an attachment uploads, else null (idle). */
  readonly uploadProgress = input<BatchProgress | null>(null);
  readonly submitText = output<ComposerSubmit>();
  readonly composeDraftChange = output<string>();
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
  readonly stickerSelect = output<ImagePackImage>();

  readonly text = signal('');

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
    const mentions = untracked(() => this.menus.activeMentions());
    // Slash commands only where they are actually parsed on send:
    // ordinary Conversation and exact-thread sends. A reply,
    // an edit and an attachment caption route through `replyMessageContent` /
    // `editMessageContent` / `mediaCaptionFields`, none of which look at a leading
    // slash — so previewing `/spoiler x` concealed while replying would promise a
    // spoiler and send the literal text.
    const content = ((this.parsesCommands()
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
    // without that class the link would render browser-blue instead of in the Theme.
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
  readonly stickerPickerOpen = signal(false);
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
  readonly stickerEnabled = computed(() =>
    this.stickerPacks().some((pack) =>
      pack.images.some((image) => image.usage.includes('sticker')),
    ),
  );
  readonly hasInsertMenu = computed(
    () => this.richActions() || this.gifEnabled() || this.stickerEnabled(),
  );
  /**
   * The three autocomplete menus: `:shortcode`, `@mention` and `/command`.
   *
   * Each engine owns its own trigger and list; the façade owns the caret handover and the
   * order the three are consulted in. The template and the specs read its signals directly —
   * forwarding them through this component would only restate them.
   *
   * PUBLIC rather than `protected`, which the template alone would have allowed. Three spec
   * files assert on `menus.emojiOpen()`, `menus.slashMatches()` and the rest, and those read
   * exactly what the menus decided; going through the DOM instead would assert something
   * weaker at 44 call sites. It is also not a widening in practice — `text`, `previewing`,
   * `pickerOpen`, `submit()` and most of the key handlers are already public, because this
   * component is driven from its specs as much as from its template. Narrowing this one
   * member would be a rule nothing else here follows.
   */
  readonly menus: ComposerAutocompletes;
  /** Staging → outgoing batches, and what comes back. */
  private readonly batches: ComposerBatchSender;
  /** The name of the file the progress bar is describing, or null when idle. */
  readonly uploadLabel: Signal<string | null>;
  /** Upload progress belonging to this room/thread, excluding a previous context's batch. */
  protected readonly contextUploadProgress: Signal<BatchProgress | null>;
  /** Whether a media send would be accepted right now (the send button says so). */
  protected readonly canSendMedia: Signal<boolean>;
  /**
   * Whether a leading slash is READ as a command on the way out.
   *
   * One computed read by BOTH {@link preview} and the slash menu (through the
   * `commandsParsed` port), because the two disagreeing is the worst of the available
   * answers: a preview that refuses to conceal a `/spoiler` while a menu offers to complete
   * one. Only `send` and `sendThreadMessage` run `slashCommandContent`; a reply, an edit and
   * an attachment caption never do.
   */
  private readonly parsesCommands = computed(
    () => !this.editing() && !this.replyingTo() && !this.hasStaged(),
  );

  private readonly textarea = viewChild<ElementRef<HTMLTextAreaElement>>('ta');
  private readonly previewPanel =
    viewChild<ElementRef<HTMLElement>>('previewPanel');
  /** Caret reads, splices, focus and auto-grow — everything that touches the textarea. */
  private readonly field: ComposerTextField;
  private readonly fileInput =
    viewChild<ElementRef<HTMLInputElement>>('fileInput');
  private readonly voiceCancel =
    viewChild<ElementRef<HTMLButtonElement>>('voiceCancel');
  private readonly injector = inject(Injector);
  private readonly emojiIndex = inject(TrnEmojiIndex);

  /** Whether this device can record voice (mic + MediaRecorder present). */
  get voiceSupported(): boolean {
    return this.attachments.voiceSupported;
  }
  private readonly drafts = inject(DraftStoreService);
  private formatSelection: FormatSelection | null = null;
  protected readonly composing = signal(false);
  protected readonly formatContext = computed(() => ({
    accountId: this.accountId(),
    roomId: this.roomId(),
    editing: this.editing(),
    editTargetId: this.editTargetId(),
  }));
  /** Resolves the user's (rebindable) formatting chords — see {@link onKeydown}. */
  private readonly shortcuts = inject(KeyboardShortcutsService);
  private wasEditing = false;
  private wasEditTargetId: string | null = null;
  private wasReplying = false;

  private wasRoomId: string | null | undefined = undefined;

  constructor() {
    this.field = new ComposerTextField(this.textarea, this.text, this.injector);
    this.menus = new ComposerAutocompletes(this.emojiIndex, this.members, {
      text: this.text,
      caret: () => this.field.caret(),
      replaceRange: (start, end, insert) =>
        this.field.replaceRange(start, end, insert),
      scrollIntoView: (id) => this.field.scrollSuggestionIntoView(id),
      insertAtCursor: (text) => this.insertEmoji(text),
      commandsParsed: this.parsesCommands,
    });
    this.batches = new ComposerBatchSender({
      uploadProgress: this.uploadProgress,
      roomId: this.roomId,
      text: this.text,
      send: (event) => this.submitMedia.emit(event),
      sendCaption: (event) => this.submitBatchCaption.emit(event),
      removeStaged: (id) => this.attachments.removeStaged(id),
      markFailed: (ids) => this.attachments.markFailed(ids),
      drafts: this.drafts,
      regrow: () => this.field.regrowAfterRender(),
    });
    this.uploadLabel = this.batches.uploadLabel;
    this.contextUploadProgress = this.batches.uploadProgress;
    this.canSendMedia = this.batches.canSend;

    // Before anything else: the attachment workflows call straight back through this, and
    // the room-change effect below can already ask them to drop a staged file.
    this.attachments.connect({
      roomId: this.roomId,
      editing: this.editing,
      uploadProgress: this.contextUploadProgress,
      sendMedia: (attachment, caption) => {
        this.batches.dispatch(
          [
            {
              id: attachment.id,
              file: attachment.file,
              media: attachment.media,
            },
          ],
          caption,
          [],
        );
      },
      endReply: () => {
        if (this.replyingTo()) {
          this.cancelReply.emit();
        }
      },
      focusInput: () => queueMicrotask(() => this.field.focus()),
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
          if (prev !== undefined) {
            this.batches.release();
          }
          // A recording belongs to the room it was started in — cancel it on a
          // room/thread switch so the mic doesn't stay open and a later Send can't
          // post the clip to the wrong room.
          if (this.recordingVoice()) {
            this.cancelVoiceRecording();
          }
          this.menus.clearChosen(); // they belong to the old conversation
          this.formatSelection = null;
          this.previewing.set(false); // the new room opens ready to write, not to read
          // Drafts only apply to compose mode; in edit mode `text` is the edit body.
          if (!this.editing()) {
            const managedDraft = this.composeDraft();
            if (managedDraft === null && prev != null) {
              this.drafts.set(prev, this.text());
            }
            this.text.set(
              managedDraft ?? (id != null ? this.drafts.get(id) : ''),
            );
            queueMicrotask(() => this.field.autoGrow());
          }
        });
      }
    });

    // Formatting UI belongs to the exact Account, Conversation and editing target.
    // Draft persistence remains with its existing Conversation owner.
    effect(() => {
      this.formatContext();
      untracked(() => {
        this.formatSelection = null;
        this.previewing.set(false);
      });
    });

    // Highlight the first suggestion whenever either result set changes.
    effect(() => {
      this.menus.emojiMatches();
      this.menus.emojiActiveIndex.set(0);
    });
    effect(() => {
      this.menus.mentionMatches();
      this.menus.mentionActiveIndex.set(0);
    });
    // Focus the input when a reply is started.
    effect(() => {
      const replying = !!this.replyingTo();
      if (replying && !this.wasReplying) {
        // A preview hides the textarea, so the focus() below would land on nothing and
        // leave the composer swallowing every keystroke of the reply being typed.
        this.previewing.set(false);
        queueMicrotask(() => this.field.focus());
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
          this.field.autoGrow();
        });
      } else if (!editing && this.wasEditing) {
        // Leaving edit mode restores the conversation's compose draft (empty when
        // none), so an edit interlude doesn't discard a half-typed message.
        const id = untracked(() => this.roomId());
        const managedDraft = untracked(() => this.composeDraft());
        this.text.set(managedDraft ?? (id != null ? this.drafts.get(id) : ''));
        this.previewing.set(false);
        queueMicrotask(() => this.field.autoGrow());
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
        if (id != null && id === this.wasRoomId) {
          if (this.composeDraft() === null && !this.editing()) {
            this.drafts.set(id, value);
          } else if (this.composeDraft() !== null) {
            this.composeDraftChange.emit(value);
          }
        }
      });
    });

    // A failed or cancelled runtime send restores its durable draft after this component
    // optimistically clears the textarea. Mirror only external changes; caret-local typing
    // does not trigger this effect because `text` is read untracked.
    effect(() => {
      const managedDraft = this.composeDraft();
      const editing = this.editing();
      if (managedDraft === null || editing) return;
      untracked(() => {
        if (this.text() !== managedDraft) {
          this.text.set(managedDraft);
          queueMicrotask(() => this.field.autoGrow());
        }
      });
    });
  }

  onInput(event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;
    this.text.set(value);
    this.field.autoGrow();
    // Broadcast typing while there's something to send; an empty field stops it. The
    // host throttles the "start"s, so emitting on every keystroke is fine.
    this.typing.emit(value.trim().length > 0);
    // Don't touch the menu mid-IME-composition: the in-progress reading is
    // transient ASCII that would mis-trigger `:shortcode` matching, and
    // rewriting the value/caret during composition drops characters.
    if (!(event as InputEvent).isComposing) {
      this.menus.sync();
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
    if (this.composing()) return;
    const el = this.textarea()?.nativeElement;
    const value = this.text();
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    this.applyEdit(applyFormat(value, start, end, action));
  }

  /** Apply the selection saved before focus moved into the Format surface. */
  protected onMenuFormat(action: FormatAction): void {
    const saved = this.formatSelection;
    if (!saved || !this.isFormatSelectionCurrent(saved) || this.composing())
      return;
    const result = applyFormat(saved.text, saved.start, saved.end, action);
    this.previewing.set(false);
    this.applyEdit(result);
    this.formatSelection = {
      context: saved.context,
      text: result.text,
      start: result.selectionStart,
      end: result.selectionEnd,
    };
    this.restoreFormatSelection(true);
  }

  /** Land an edit in the field, then do the bookkeeping a keystroke would have done. */
  private applyEdit(result: EditResult): void {
    this.field.write(result);
    // Without this an open mention menu keeps a query anchored to a caret that has moved —
    // accepting it then splices at a stale offset — and a message begun entirely from the
    // format action never announces that anyone is typing.
    this.menus.sync();
    this.typing.emit(result.text.trim().length > 0);
  }

  /** Swap between writing and previewing, returning focus to the input on the way back. */
  onTogglePreview(): void {
    if (this.composing()) return;
    const next = !this.previewing();
    if (next) this.captureFormatSelection();
    this.previewing.set(next);
    if (next) {
      const context = this.formatContext();
      afterNextRender(
        () => {
          if (context === this.formatContext() && this.previewing()) {
            this.previewPanel()?.nativeElement.focus();
          }
        },
        { injector: this.injector },
      );
    } else {
      this.restoreFormatSelection(true);
    }
  }

  onEnter(event: Event): void {
    const keyEvent = event as KeyboardEvent;
    // An Enter that confirms an IME candidate must reach neither send nor
    // accept — let the composition commit normally.
    if (keyEvent.isComposing) {
      return;
    }
    if (this.menus.acceptHighlighted()) {
      keyEvent.preventDefault();
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
    if (this.menus.acceptHighlighted()) {
      event.preventDefault();
    }
  }

  /** Arrow Down moves the highlight when a menu is open. */
  onArrowDown(event: Event): void {
    if (this.menus.moveHighlight(1)) {
      event.preventDefault();
    }
  }

  /** Closing the field hides any open menu; a menu click keeps focus (see template). */
  onBlur(): void {
    this.menus.closeAll();
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
      // Read BEFORE the box is emptied: `activeMentions()` matches the chosen users against
      // the current text, so computing it afterwards matches them against nothing.
      const mentions = this.menus.activeMentions();
      this.text.set('');
      // One batch at a time — the check lives in `dispatchMedia`, so every route to a send is
      // covered rather than just this one. Nothing below runs when it refuses: a blocked send
      // must not clear the composer as though it had gone out.
      if (
        !this.batches.dispatch(
          batch.map(({ id, file, media }) => ({ id, file, media })),
          typed.trim(),
          mentions,
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
      this.field.regrowAfterRender();
      return;
    }
    if (this.textSending()) return;
    const value = this.text().trim();
    if (!value) {
      return;
    }
    this.submitText.emit({
      text: value,
      mentions: this.menus.activeMentions(),
    });
    this.typing.emit(false); // a sent message ends the typing notification
    this.resetMenus();
    // Clear the saved Aa selection when the message is sent so it cannot be applied to a later
    // draft.
    this.formatSelection = null;
    if (!this.editing() && this.composeDraft() === null) {
      // Conversation-owned text clears from the authoritative input signal. The legacy
      // thread composer still owns its local draft and therefore clears it here.
      this.text.set('');
      this.field.regrowAfterRender();
    }
  }

  /** Close both autocomplete menus and forget the tracked mentions. */
  private resetMenus(): void {
    this.menus.reset();
    // A grid left open across a send is the one remaining route to two uploads at once: its
    // items call `sendMedia` directly, and unlike the input button they are not disabled
    // while an upload runs. `dispatchMedia` refuses it either way; closing the grid means the
    // user does not lose a chosen GIF to that refusal.
    this.gifPickerOpen.set(false);
    // Leaving the preview on is a trap rather than a preference: it hides the textarea, so a
    // composer that lands in preview mode after a send or a room switch looks broken — an
    // empty box that swallows typing until you notice the eye button.
    this.previewing.set(false);
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

  /**
   * A press on the field's own padding is a press on the input it draws.
   *
   * The box belongs to the field now, and the field is bigger than the textarea: with
   * `align-items: end` the buttons sit at the bottom, so a grown input leaves empty field
   * above them — 87px of it on a five-line draft, measured. That area shares the input's
   * background and reads as part of it, and before the box moved it was outside the box
   * entirely. Every other chat client forwards the click; dropping it is the surprise.
   *
   * `target === currentTarget` is what keeps this from stealing presses aimed at the buttons
   * inside the field: only a press that landed on the field ITSELF gets forwarded.
   */
  protected onFieldPress(event: Event): void {
    if (event.target !== event.currentTarget) {
      return;
    }
    // `preventDefault` before the focus, not after, and not optional: a press's DEFAULT action
    // sets focus, and it runs after this handler — so focusing here and letting the default
    // through moves focus straight back off the textarea and onto nothing. The suggestion
    // options cancel their `mousedown` for the same reason.
    event.preventDefault();
    this.field.focus();
  }

  /** Save the exact caret or selection before the Aa trigger takes focus. */
  protected captureFormatSelection(): void {
    const el = this.textarea()?.nativeElement;
    if (!el || this.composing()) return;
    this.formatSelection = {
      context: this.formatContext(),
      text: this.text(),
      start: el.selectionStart,
      end: el.selectionEnd,
    };
  }

  protected restoreFormatSelection(focus = false): void {
    const saved = this.formatSelection;
    if (!saved) return;
    const restore = () => {
      if (!this.isFormatSelectionCurrent(saved) || this.composing()) return;
      const el = this.textarea()?.nativeElement;
      if (focus) el?.focus();
      el?.setSelectionRange(saved.start, saved.end);
      this.field.autoGrow();
    };
    restore();
    if (focus) afterNextRender(restore, { injector: this.injector });
  }

  private isFormatSelectionCurrent(saved: FormatSelection): boolean {
    return saved.context === this.formatContext() && saved.text === this.text();
  }

  /** Toggle the emoji picker, closing the other overlays (only one at a time). */
  toggleEmojiPicker(): void {
    this.gifPickerOpen.set(false);
    this.stickerPickerOpen.set(false);
    this.pickerOpen.set(!this.pickerOpen());
  }

  /** Toggle the GIF grid, closing the other overlays (only one at a time). */
  toggleGifPicker(): void {
    this.pickerOpen.set(false);
    this.stickerPickerOpen.set(false);
    this.attachments.toggleGifPicker();
  }

  toggleStickerPicker(): void {
    this.pickerOpen.set(false);
    this.gifPickerOpen.set(false);
    this.stickerPickerOpen.update((open) => !open);
  }

  onStickerSelect(sticker: ImagePackImage): void {
    this.stickerPickerOpen.set(false);
    this.stickerSelect.emit(sticker);
    queueMicrotask(() => this.field.focus());
  }

  closeStickerPicker(): void {
    this.stickerPickerOpen.set(false);
    queueMicrotask(() => this.field.focus());
  }

  manageImagePacks(): void {
    this.stickerPickerOpen.set(false);
    this.applicationSurfaces
      .open({
        surface: { kind: 'settings', section: 'stickers' },
        context: {
          sourceRoomId: this.roomId() ?? undefined,
          restoreFocus: () => this.field.focus(),
        },
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** Begin recording a voice message; toasts and resets if the mic is unavailable. */
  async startVoiceRecording(): Promise<void> {
    await this.attachments.startVoiceRecording();
    if (this.recordingVoice()) {
      afterNextRender(() => this.voiceCancel()?.nativeElement.focus(), {
        injector: this.injector,
      });
    }
  }

  /** Stop recording and send the clip as a voice message. */
  stopVoiceRecording(): void {
    const wasRecording = this.recordingVoice();
    this.attachments.stopVoiceRecording();
    if (wasRecording) {
      this.field.focusAfterRender();
    }
  }

  /** Abort the recording, discarding the clip. */
  cancelVoiceRecording(): void {
    const wasRecording = this.recordingVoice();
    this.attachments.cancelVoiceRecording();
    if (wasRecording) {
      this.field.focusAfterRender();
    }
  }

  /** A GIF was chosen → download it and send it through the media path. */
  onGifSelect(gif: GifResult): void {
    this.attachments.gifSelected(gif);
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
    if (!this.canSendMedia()) {
      return;
    }
    // So the row reads as uploading rather than as still-failed. Only this one: the others
    // are still failed and have not been retried.
    this.attachments.clearFailed([id]);
    // Clearing the flag unmounts the row's retry button — the element that currently has
    // focus — which would strand a keyboard user at the top of the page. Same remedy, and the
    // same reason, as `removeStaged`.
    queueMicrotask(() => this.field.focus());
    // A retry is a send: it takes whatever caption is in the box and clears it the way
    // `submit()` does, before dispatching and for the same reason.
    const typed = this.text();
    const mentions = this.menus.activeMentions(); // before the box is emptied, as in `submit()`
    this.text.set('');
    if (
      !this.batches.dispatch(
        [
          {
            id: attachment.id,
            file: attachment.file,
            media: attachment.media,
          },
        ],
        typed.trim(),
        mentions,
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
    queueMicrotask(() => this.field.focus());
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
    if (this.menus.closeTopmost()) {
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
    if (this.stickerPickerOpen()) {
      this.stickerPickerOpen.set(false);
      return;
    }
    // Not while a batch is going out: those rows are what its outcomes will report on, and
    // clearing them means a failure has nowhere to land — the toast would then promise files
    // are "still in the composer" that are not.
    if (this.hasStaged() && !this.batches.inFlight()) {
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
      this.field.autoGrow();
    });
  }

  onArrowUp(event: Event): void {
    if (this.menus.moveHighlight(-1)) {
      event.preventDefault();
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
}
