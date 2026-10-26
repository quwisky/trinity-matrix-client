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
import { TrnButton, TrnIconButton } from '@trinity/components/controls';
import {
  BannerComponent,
  TrnSpinnerComponent,
  TrnTooltip,
} from '@trinity/components/generic-content';
import {
  DraftStoreService,
  KeyboardShortcutsService,
  type CaptureKind,
  TrackFileChooserDirective,
} from '@trinity/platform-native';
import { type GifResult } from '@trinity/data-access/gif';
import type { ImagePack, ImagePackImage } from '@trinity/data-access/media';
import {
  SHORTCODE_JOINER,
  type FormatAction,
  type Mention,
} from '@trinity/util/matrix';
import { ComposerFormatMenuComponent } from './composer-format-menu/composer-format-menu.component';
import { ComposerAttachmentStripComponent } from './composer-attachment-strip/composer-attachment-strip.component';
import { ComposerInsertMenuComponent } from './composer-insert-menu/composer-insert-menu.component';
import { ComposerSuggestionsComponent } from './composer-suggestions/composer-suggestions.component';
import { ComposerBannerComponent } from './composer-banner/composer-banner.component';
import { ComposerVoiceBarComponent } from './composer-voice-bar/composer-voice-bar.component';
import { MatrixHtmlDirective } from '../message-presentation/matrix-html.directive';
import { ComposerAttachmentsService } from './composer-attachments.service';
import {
  type BatchItem,
  type BatchOutcome,
  type BatchProgress,
} from '../shared/send-media-batch';
import { ComposerTextField } from './composer-text-field';
import { ComposerBatchSender } from './composer-batch-sender';
import { ComposerAutocompletes } from './composer-autocompletes';
import { ComposerDrafts } from './composer-drafts';
import { ComposerFormatting } from './composer-formatting';
import { composerPreview } from './composer-preview';
import { TrnIconComponent } from '@trinity/components/foundations';
import {
  TrnAnchoredOverlayDirective,
  TrnSurfaceService,
  type TrnDialogRef,
} from '@trinity/components/overlay';
import { TrnEmojiIndex, type TrnEmojiPick } from '@trinity/components/controls';
import { type MentionMember } from './mention-autocomplete';
import { ExpressionPickerComponent } from '../expression-picker/expression-picker.component';
import {
  ExpressionSheetComponent,
  type ExpressionSheetBridge,
} from '../expression-picker/expression-sheet.component';
import { ComposerExpressionTabPreference } from '@trinity/data-access/timeline';
import { WorkspaceApplicationSurfaceService } from '@trinity/application/workspace';

/** A room member offered by the @-mention autocomplete; the shape of the `members` input. */
export type { MentionMember };

/** What the composer emits on submit: the message text plus any @-mentioned users. */
export interface ComposerSubmit {
  text: string;
  mentions: Mention[];
}

/** Instance counter behind {@link MessageComposerComponent.pickerId}. */
let nextPickerId = 0;

/**
 * Composer: Enter sends, Shift+Enter inserts a newline. In edit mode it is prefilled with the
 * message draft and Esc cancels. The emoji button opens one panel for GIFs, stickers and emoji;
 * an emoji inserts at the cursor.
 *
 * It owns the textarea: its value, its caret, the draft behind it and what a submit makes of
 * them. The autocompletes and every non-text attachment ({@link ComposerAttachmentsService})
 * live beside it, and the template's child components render what they hold.
 */
@Component({
  selector: 'trn-message-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TrackFileChooserDirective,
    BannerComponent,
    ComposerBannerComponent,
    ComposerVoiceBarComponent,
    MatrixHtmlDirective,
    TrnButton,
    TrnIconButton,
    TrnIconComponent,
    TrnTooltip,
    TrnSpinnerComponent,
    ExpressionPickerComponent,
    ComposerFormatMenuComponent,
    ComposerAttachmentStripComponent,
    ComposerInsertMenuComponent,
    ComposerSuggestionsComponent,
    TrnAnchoredOverlayDirective,
  ],
  // Per composer instance, not per app: the room and thread composers are alive at once and
  // each needs its own staged file, GIF grid and recording.
  providers: [ComposerAttachmentsService],
  // Escape is handled at the host, not on the textarea, because what it dismisses can be open
  // without the textarea holding focus (the expression panel's own trigger, for one). The panel
  // renders in the overlay container, outside this host, and asks to be dismissed through its
  // own output. Bound once: a second binding on the textarea would close two things per press.
  host: { '(keydown.escape)': 'onEscape()' },
  templateUrl: './message-composer.component.html',
  styleUrl: './message-composer.component.scss',
})
export class MessageComposerComponent {
  private readonly applicationSurfaces = inject(
    WorkspaceApplicationSurfaceService,
  );
  private readonly destroyRef = inject(DestroyRef);
  private readonly expressionTab = inject(ComposerExpressionTabPreference);
  /**
   * The expression panel's id. Unique per instance because the room's and the thread panel's
   * composers are routinely alive at once; a shared id would leave the trigger's
   * `aria-controls` resolving to whichever panel the document reached first.
   */
  protected readonly pickerId = `composer-expressions-${nextPickerId++}`;

  readonly roomName = input('');
  /** Idle placeholder override (e.g. the thread composer); defaults to "Message #room". */
  readonly placeholder = input('');
  readonly editing = input(false);
  readonly draft = input('');
  /**
   * Conversation-owned compose draft. Null keeps the legacy thread-local persistence path
   * until thread state moves behind its Conversation child.
   */
  readonly composeDraft = input<string | null>(null);
  /** A Conversation-owned text attempt is still resolving through the SDK. */
  readonly textSending = input(false);
  /** The Conversation is not ready to send (loading or failed); typing and drafts stay live. */
  readonly sendBlocked = input(false);
  /** Why the user may not post here; while set, a notice replaces every composing control. */
  readonly postUnavailableReason = input<string | null>(null);
  /**
   * Id of the message being edited (null when not editing). The prefill keys on this, not on
   * {@link draft}, so re-targeting refreshes the field while a mid-edit body change of the
   * *same* target (redaction, a concurrent multi-device edit, a late echo) never clobbers
   * in-progress text.
   */
  readonly editTargetId = input<string | null>(null);
  /**
   * Active room/thread id. A change discards any staged (unsent) attachment: the composer
   * instance is reused across rooms, so it must not leak.
   */
  readonly roomId = input<string | null>(null);
  /** Account identity distinguishes two Conversations in the same Matrix Room. */
  readonly accountId = input<string | null>(null);
  /** Sender name of the message being replied to, or '' when not replying. */
  readonly replyingTo = input('');
  /** Room members, for the @-mention autocomplete (empty disables mentions). */
  readonly members = input<readonly MentionMember[]>([]);
  /**
   * Whether to offer the room-scoped rich actions (poll, location, voice). They act on the
   * *active room* via their own services and can't be routed into a thread, so the thread
   * composer sets this false.
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
   * Separate from {@link submitText}, which is routed by the composer's CURRENT edit/reply
   * state: this text was written before an upload that can take minutes, by when the user may
   * be editing something else, and routing it then would apply the caption as that edit.
   */
  readonly submitBatchCaption = output<ComposerSubmit>();
  /**
   * Send these files, in this order, as N events, with an optional caption.
   *
   * `onOutcomes` rather than a return value because an `output` cannot have one, and the
   * composer has to learn which items failed: those stay staged so they can be retried.
   *
   * The host MUST call it when the batch settles; it also releases the one-at-a-time send
   * latch. Deriving that from `uploadProgress` cannot work: a send can finish before the host's
   * progress is observable, and a signal input, written only at change detection and skipped
   * when the value is `Object.is`-equal, never sees it move.
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
   * The user typed something (or cleared the field): `true` while there is text to send,
   * `false` once the field is empty. The host debounces it into a Matrix typing notification.
   */
  readonly typing = output<boolean>();
  readonly stickerSelect = output<ImagePackImage>();

  readonly text = signal('');

  /** Whether the preview is showing in place of the input. */
  readonly previewing = signal(false);

  /** The message as it will arrive; see {@link composerPreview}. */
  readonly preview = computed(() =>
    composerPreview(
      this.text(),
      untracked(() => this.menus.activeMentions()),
      this.parsesCommands(),
    ),
  );

  /**
   * Every way something other than typed text gets into the message: a picked, pasted or
   * dropped file, a GIF, a poll, a location, a voice clip. The template binds its signals as
   * `attachments.x`; its methods are wrapped below where they need composer state.
   */
  protected readonly attachments = inject(ComposerAttachmentsService);

  /** Whether the expression panel (GIFs, stickers and emoji) is open. */
  readonly pickerOpen = signal(false);
  /** Whether the open panel is a bottom sheet rather than anchored; decided at each open. */
  protected readonly pickerSheet = signal(false);
  /** An edit cannot become a GIF or a sticker, so editing offers Emoji alone. */
  protected readonly panelGifEnabled = computed(
    () => this.attachments.gifEnabled() && !this.editing(),
  );
  protected readonly panelStickerEnabled = computed(
    () => this.stickerEnabled() && !this.editing(),
  );
  readonly stickerEnabled = computed(() =>
    this.stickerPacks().some((pack) =>
      pack.images.some((image) => image.usage.includes('sticker')),
    ),
  );
  /**
   * Whether the `+` opens the insert tray rather than the file picker directly. With only one
   * insert action to offer (the thread composer) a one-item menu is friction, so `+` stays a
   * plain attach button; it becomes a tray when this host can capture, which gives the thread
   * composer the tray on phones. GIFs and stickers live in the expression panel, not here.
   */
  readonly hasInsertMenu = computed(
    () => this.richActions() || this.attachments.captureMode !== 'none',
  );
  /**
   * The three autocomplete menus: `:shortcode`, `@mention` and `/command`.
   *
   * Each engine owns its own trigger and list; the façade owns the caret handover and the
   * order the three are consulted in.
   *
   * PUBLIC rather than `protected` because specs assert on `menus.emojiOpen()`,
   * `menus.slashMatches()` and the rest, which read exactly what the menus decided; going
   * through the DOM would assert something weaker. `text`, `previewing`, `pickerOpen`,
   * `submit()` and most key handlers are public for the same reason.
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
  /** The suggestion list the input controls, or null while none is open. */
  protected readonly activeListId = computed(() =>
    this.menus.mentionOpen()
      ? 'mention-suggestions'
      : this.menus.emojiOpen()
        ? 'emoji-suggestions'
        : this.menus.slashOpen()
          ? 'slash-suggestions'
          : null,
  );
  /** The highlighted suggestion option, which the input exposes as its active descendant. */
  protected readonly activeOptionId = computed(() =>
    this.menus.mentionOpen()
      ? 'mention-suggestion-' + this.menus.mentionActiveIndex()
      : this.menus.emojiOpen()
        ? 'emoji-suggestion-' + this.menus.emojiActiveIndex()
        : this.menus.slashOpen()
          ? 'slash-suggestion-' + this.menus.slashActiveIndex()
          : null,
  );
  private readonly cannotSend = computed(
    () => this.sendBlocked() || !!this.postUnavailableReason(),
  );
  /** Whether the send button would be accepted: something to send and nothing in the way. */
  protected readonly canSubmit = computed(
    () =>
      !this.cannotSend() &&
      !this.textSending() &&
      (!!this.text().trim() || this.attachments.hasStaged()) &&
      (this.editing() || !this.attachments.hasStaged() || this.canSendMedia()),
  );
  /**
   * Whether a leading slash is READ as a command on the way out.
   *
   * One computed read by BOTH {@link preview} and the slash menu (through the `commandsParsed`
   * port), so they cannot disagree: a preview refusing to conceal a `/spoiler` while a menu
   * offers to complete one. Only `send` and `sendThreadMessage` run `slashCommandContent`; a
   * reply, an edit and an attachment caption never do.
   */
  private readonly parsesCommands = computed(
    () =>
      !this.editing() && !this.replyingTo() && !this.attachments.hasStaged(),
  );

  private readonly textarea = viewChild<ElementRef<HTMLTextAreaElement>>('ta');
  private readonly previewPanel =
    viewChild<ElementRef<HTMLElement>>('previewPanel');
  /** Caret reads, splices, focus and auto-grow — everything that touches the textarea. */
  private readonly field: ComposerTextField;
  private readonly fileInput =
    viewChild<ElementRef<HTMLInputElement>>('fileInput');
  private readonly photoCaptureInput =
    viewChild<ElementRef<HTMLInputElement>>('photoCaptureInput');
  private readonly videoCaptureInput =
    viewChild<ElementRef<HTMLInputElement>>('videoCaptureInput');
  private readonly voiceBar = viewChild(ComposerVoiceBarComponent);
  private readonly pickerTrigger =
    viewChild<ElementRef<HTMLButtonElement>>('pickerTrigger');
  private readonly surfaces = inject(TrnSurfaceService);
  /** The open expression sheet, while there is one. */
  private pickerSheetRef: TrnDialogRef | null = null;
  private readonly injector = inject(Injector);
  private readonly emojiIndex = inject(TrnEmojiIndex);

  private readonly drafts = inject(DraftStoreService);
  protected readonly formatting: ComposerFormatting;
  protected readonly composing = signal(false);
  protected readonly formatContext = computed(() => ({
    accountId: this.accountId(),
    roomId: this.roomId(),
    editing: this.editing(),
    editTargetId: this.editTargetId(),
  }));
  /** Resolves the user's (rebindable) formatting chords — see {@link onKeydown}. */
  private readonly shortcuts = inject(KeyboardShortcutsService);
  private wasReplying = false;

  constructor() {
    // Warm the lazy emoji index so a quickly typed `:shortcode:` still converts.
    void this.emojiIndex.load();
    // Read the panel's last-used tab before anyone can open it, so it opens there rather than
    // switching under the pointer. A failed read leaves Emoji, the default.
    this.expressionTab
      .restore()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
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
      blocked: this.cannotSend,
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

    // Before anything else: the attachment workflows call back through this, and the
    // room-change effect below can already ask them to drop a staged file.
    this.attachments.connect({
      roomId: this.roomId,
      accountId: this.accountId,
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
      closePicker: () => this.pickerOpen.set(false),
      openFileDialog: () => this.fileInput()?.nativeElement.click(),
      openCaptureInput: (kind) =>
        (kind === 'photo'
          ? this.photoCaptureInput()
          : this.videoCaptureInput()
        )?.nativeElement.click(),
    });

    // Unassigned on purpose: its effects are its whole lifetime.
    new ComposerDrafts({
      roomId: this.roomId,
      editing: this.editing,
      editTargetId: this.editTargetId,
      draft: this.draft,
      composeDraft: this.composeDraft,
      text: this.text,
      store: this.drafts,
      emitDraft: (draft) => this.composeDraftChange.emit(draft),
      leaveRoom: (prev) => {
        this.clearStaged();
        if (prev !== undefined) {
          this.batches.release();
        }
        // A recording belongs to the room it was started in: cancel it on a room/thread switch
        // so the mic doesn't stay open and a later Send can't post the clip to the wrong room.
        if (this.attachments.recordingVoice()) {
          this.cancelVoiceRecording();
        }
        this.menus.clearChosen(); // they belong to the old conversation
        // Safe before `formatting` is assigned below: effects first run after construction.
        this.formatting.clearSelection();
        this.previewing.set(false); // the new room opens ready to write, not to read
      },
      leavePreview: () => this.previewing.set(false),
      autoGrow: () => this.field.autoGrow(),
      focusAtEnd: () => {
        const el = this.textarea()?.nativeElement;
        el?.focus();
        el?.setSelectionRange(el.value.length, el.value.length);
      },
    });

    this.formatting = new ComposerFormatting(
      {
        text: this.text,
        previewing: this.previewing,
        composing: this.composing,
        editing: this.editing,
        context: this.formatContext,
        textarea: this.textarea,
        previewPanel: this.previewPanel,
        shortcuts: this.shortcuts,
        write: (result) => this.field.write(result),
        autoGrow: () => this.field.autoGrow(),
        syncMenus: () => this.menus.sync(),
        typing: (hasText) => this.typing.emit(hasText),
      },
      this.injector,
    );

    // The sheet follows `pickerOpen` like the anchored panel, so every path that closes the
    // panel (a pick, a send, a room switch, Escape) closes the sheet too.
    effect(() => {
      const sheetOpen = this.pickerOpen() && this.pickerSheet();
      untracked(() =>
        sheetOpen ? this.openPickerSheet() : this.closePickerSheet(),
      );
    });
    this.destroyRef.onDestroy(() => this.closePickerSheet());

    // The voice bar is gone while the notice shows, so nothing could stop an open mic.
    effect(() => {
      if (
        this.postUnavailableReason() &&
        untracked(() => this.attachments.recordingVoice())
      ) {
        untracked(() => this.cancelVoiceRecording());
      }
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
  }

  onInput(event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;
    this.text.set(value);
    this.field.autoGrow();
    // The host throttles the "start"s, so emitting on every keystroke is fine.
    this.typing.emit(value.trim().length > 0);
    // Don't touch the menu mid-IME-composition: the in-progress reading is transient ASCII that
    // would mis-trigger `:shortcode` matching, and rewriting the value/caret during composition
    // drops characters.
    if (!(event as InputEvent).isComposing) {
      this.menus.sync();
    }
  }

  onKeydown(event: Event): void {
    this.formatting.onKeydown(event);
  }

  insertQuote(block: string): void {
    this.formatting.insertQuote(block);
  }

  onFormat(action: FormatAction): void {
    this.formatting.onFormat(action);
  }

  onTogglePreview(): void {
    this.formatting.onTogglePreview();
  }

  onEnter(event: Event): void {
    const keyEvent = event as KeyboardEvent;
    // An Enter that confirms an IME candidate must reach neither send nor accept: let the
    // composition commit normally.
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

  /**
   * Send on Enter / the send button: a staged attachment (with the text as its caption) takes
   * precedence, else the plain text message.
   */
  submit(): void {
    if (this.cannotSend()) return;
    // Never mixes with an edit (attach is disabled while editing), so edit mode ignores staging.
    const batch = this.editing() ? [] : this.attachments.staged();
    if (batch.length) {
      // Emptied BEFORE the dispatch, not after. A send can settle synchronously (a 0-byte file
      // never reaches the network) and the sender gives the caption back when nothing carried it,
      // so clearing afterwards would wipe what it had just restored.
      const typed = this.text();
      // Read BEFORE the box is emptied: `activeMentions()` matches the chosen users against the
      // current text, so afterwards it matches them against nothing.
      const mentions = this.menus.activeMentions();
      this.text.set('');
      // One batch at a time; the check lives in the sender, so every route to a send is covered.
      // Nothing below runs when it refuses: a blocked send must not clear the composer.
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
      // A media send carries no reply relation, so end any active reply, else the banner
      // lingers and the next plain message silently replies to a now-stale target.
      if (this.replyingTo()) {
        this.cancelReply.emit();
      }
      // The staged rows stay until their outcomes arrive: failed ones must remain to be retried.
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
    // The saved Aa selection must not be applied to a later draft.
    this.formatting.clearSelection();
    if (!this.editing() && this.composeDraft() === null) {
      // Conversation-owned text clears from the authoritative input signal; the legacy thread
      // composer owns its local draft and clears it here.
      this.text.set('');
      this.field.regrowAfterRender();
    }
  }

  /** Close both autocomplete menus and forget the tracked mentions. */
  private resetMenus(): void {
    this.menus.reset();
    // A GIF grid left open across a send is a route to two uploads at once: its items call
    // `sendMedia` directly and are not disabled while an upload runs. The sender refuses it
    // either way; closing the panel means the user does not lose a chosen GIF to that refusal.
    this.pickerOpen.set(false);
    // Leaving the preview on is a trap: it hides the textarea, so a composer that lands in
    // preview mode after a send or a room switch looks like an empty box that swallows typing.
    this.previewing.set(false);
  }

  /** The emoji picker chose an emoji → insert its native character at the cursor. */
  onPickerSelect(pick: TrnEmojiPick): void {
    // No emptiness check: the wrapper drops picks with no character.
    this.insertEmoji(pick.native, pick.native.startsWith(':'));
  }

  /** Open the create-poll dialog (starts a poll in the active room on confirm). */
  openPollDialog(): void {
    if (this.cannotSend()) return;
    this.attachments.openPollDialog();
  }

  /** Share the device's current location to the active room. */
  shareLocation(): void {
    if (this.cannotSend()) return;
    this.attachments.shareLocation();
  }

  /**
   * A press on the field's own padding is a press on the input it draws.
   *
   * The box belongs to the field, which is bigger than the textarea: with `align-items: end`
   * the buttons sit at the bottom, so a grown input leaves empty field above them that shares
   * the input's background and reads as part of it.
   *
   * `target === currentTarget` keeps this from stealing presses aimed at the buttons inside
   * the field: only a press that landed on the field ITSELF is forwarded.
   */
  protected onFieldPress(event: Event): void {
    if (event.target !== event.currentTarget) {
      return;
    }
    // `preventDefault` is not optional: a press's DEFAULT action sets focus and runs after this
    // handler, so focusing here and letting the default through moves focus straight back off
    // the textarea. The suggestion options cancel their `mousedown` for the same reason.
    event.preventDefault();
    this.field.focus();
  }

  /**
   * Open or close the expression panel (GIFs, stickers and emoji): a bottom sheet where the
   * app prefers sheets (a phone, a tablet or a narrow window), the anchored panel otherwise.
   */
  togglePicker(): void {
    if (!this.pickerOpen()) {
      this.pickerSheet.set(this.surfaces.prefersSheet());
    }
    this.pickerOpen.update((open) => !open);
  }

  private openPickerSheet(): void {
    if (this.pickerSheetRef) {
      return;
    }
    const bridge: ExpressionSheetBridge = {
      panelId: this.pickerId,
      gifEnabled: this.panelGifEnabled,
      stickerEnabled: this.panelStickerEnabled,
      stickerPacks: this.stickerPacks,
      gifBusy: this.attachments.gifDownloading,
      emojiPick: (pick) => this.onPickerSelect(pick),
      gifSelect: (gif) => this.onGifSelect(gif),
      stickerSelect: (sticker) => this.onStickerSelect(sticker),
      manage: () => this.manageImagePacks(),
      dismiss: () => this.closePicker(),
    };
    const ref = this.surfaces.open(ExpressionSheetComponent, {
      ariaLabel: 'Emoji, GIFs and stickers',
      // The panel puts focus on its content itself and the pickers move it on into their search
      // fields; the dialog's own autofocus would run after them and take it back.
      autoFocus: false,
      inputs: { bridge },
    });
    this.pickerSheetRef = ref;
    ref.closed.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (this.pickerSheetRef === ref) {
        // Closed by the person (handle, backdrop or Escape): the panel is shut.
        this.pickerSheetRef = null;
        this.pickerOpen.set(false);
      }
    });
  }

  private closePickerSheet(): void {
    const ref = this.pickerSheetRef;
    this.pickerSheetRef = null;
    ref?.close();
  }

  onStickerSelect(sticker: ImagePackImage): void {
    if (this.cannotSend() || this.editing()) return;
    this.pickerOpen.set(false);
    this.stickerSelect.emit(sticker);
    queueMicrotask(() => this.field.focus());
  }

  /**
   * The panel asked to be dismissed (Escape inside it). From the anchored panel the caret goes
   * back to the input; a sheet hands focus back to the button that opened it, as sheets do.
   */
  closePicker(): void {
    const sheet = this.pickerSheet();
    this.pickerOpen.set(false);
    queueMicrotask(() =>
      sheet ? this.pickerTrigger()?.nativeElement.focus() : this.field.focus(),
    );
  }

  manageImagePacks(): void {
    this.pickerOpen.set(false);
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
    if (this.attachments.recordingVoice()) {
      afterNextRender(() => this.voiceBar()?.focusCancel(), {
        injector: this.injector,
      });
    }
  }

  /** Stop recording and send the clip as a voice message. */
  stopVoiceRecording(): void {
    if (this.cannotSend()) return;
    const wasRecording = this.attachments.recordingVoice();
    this.attachments.stopVoiceRecording();
    if (wasRecording) {
      this.field.focusAfterRender();
    }
  }

  /** Abort the recording, discarding the clip. */
  cancelVoiceRecording(): void {
    const wasRecording = this.attachments.recordingVoice();
    this.attachments.cancelVoiceRecording();
    if (wasRecording) {
      this.field.focusAfterRender();
    }
  }

  /**
   * A GIF was chosen → download it and send it through the media path; the panel closes once
   * it arrives. Refused while editing, while the Conversation cannot send or while another
   * upload runs.
   */
  onGifSelect(gif: GifResult): void {
    if (
      this.cannotSend() ||
      this.editing() ||
      this.contextUploadProgress() !== null
    ) {
      return;
    }
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

  /** Take photo, from the insert menu. */
  onTakePhoto(): void {
    this.attachments.capture('photo');
  }

  /** Record video, from the insert menu. */
  onRecordVideo(): void {
    this.attachments.capture('video');
  }

  /** A mobile-web capture input changed → stage what the camera produced. */
  onCaptureInput(event: Event, kind: CaptureKind): void {
    this.attachments.captureInputPicked(event, kind);
  }

  /**
   * Re-send one failed file on its own, leaving the rest of the batch staged. Pressing send
   * again would retry *everything* staged, which is wrong when only one failed and the others
   * are files the user has since added.
   */
  protected retryStaged(id: string): void {
    const attachment = this.attachments
      .staged()
      .find((candidate) => candidate.id === id);
    if (!attachment) {
      return;
    }
    // The one-at-a-time check is repeated here because the failed flag is cleared BEFORE
    // dispatching; a refusal would otherwise leave the row looking like it had been sent.
    if (!this.canSendMedia()) {
      return;
    }
    // So the row reads as uploading rather than still-failed. Only this one: the others have
    // not been retried.
    this.attachments.clearFailed([id]);
    // Clearing the flag unmounts the row's retry button, which has focus, and would strand a
    // keyboard user at the top of the page. Same remedy as `removeStaged`.
    queueMicrotask(() => this.field.focus());
    // A retry is a send: it takes the caption in the box and clears it as `submit()` does,
    // before dispatching and for the same reason.
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
    // Whatever removed the row (its × or a send), the focused element is about to be destroyed,
    // which drops focus to <body> and strands a keyboard user at the top of the page. Queued,
    // like the staging path's own focus call: the row is in the DOM until change detection runs.
    queueMicrotask(() => this.field.focus());
  }

  /**
   * Stage files that came from outside the composer, such as a drop on the conversation.
   *
   * Public because the message list owns the drop target; the refusal rules stay here so a drop
   * cannot bypass what a paste respects.
   */
  stageFiles(files: readonly File[]): void {
    this.attachments.stageExternal(files);
  }

  /** Drop every staged attachment. */
  clearStaged(): void {
    this.attachments.clearStaged();
  }

  /** Paste an image from the clipboard → stage it as an attachment. */
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
    // Not while a batch is going out: those rows are what its outcomes report on, and clearing
    // them leaves a failure nowhere to land, so the toast would promise files "still in the
    // composer" that are not.
    if (this.attachments.hasStaged() && !this.batches.inFlight()) {
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

  /**
   * Insert an emoji at the cursor (or append), then keep the textarea focused. A `:shortcode:`
   * is spaced off a touching word, which would otherwise keep it text on send.
   */
  insertEmoji(text: string, shortcode = false): void {
    const el = this.textarea()?.nativeElement;
    const value = this.text();
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const pad = (char: string | undefined) =>
      shortcode && SHORTCODE_JOINER.test(char ?? '') ? ' ' : '';
    const emoji = pad(value[start - 1]) + text + pad(value[end]);
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
    // Empty composer + Up arrow edits the last message; otherwise (editing, typed text, or a
    // staged attachment) the arrow moves the cursor.
    if (
      this.editing() ||
      this.text().length > 0 ||
      this.attachments.hasStaged()
    ) {
      return;
    }
    event.preventDefault();
    this.editLast.emit();
  }
}
