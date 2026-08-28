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
import {
  HlmDropdownMenu,
  HlmDropdownMenuItem,
  HlmDropdownMenuTrigger,
} from '@trinity/helm/dropdown-menu';
import {
  TrnActionSheetService,
  type ActionSheetButton,
  type TrnActionSheetRef,
} from '@trinity/components/overlay';
import { TrnSpinnerComponent } from '@trinity/components/spinner';
import { TrnTooltip } from '@trinity/components/tooltip';
import { TrnIconComponent, type TrnIconName } from '@trinity/components/icon';
import { isMobileOs } from '@trinity/platform-native';

interface ComposerInsertAction {
  readonly text: string;
  readonly icon: TrnIconName;
  readonly testId: string;
  readonly disabled: boolean;
  readonly run: () => void;
}

interface OwnedSheet {
  readonly ref: TrnActionSheetRef;
  picked: boolean;
  restoreOnDismiss: boolean;
}

/**
 * The composer's `+`: every way something other than typed text gets into a message.
 *
 * A dropdown tray when there is more than one action to offer, a plain attach button when
 * there is not (see {@link hasMenu}). Presentational — the workflows behind the actions live in
 * `ComposerAttachmentsService`, and the host is `display: contents` so the button stays a
 * direct flex item of the composer's input row.
 */
@Component({
  selector: 'trn-composer-insert-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TrnIconComponent,
    HlmDropdownMenu,
    HlmDropdownMenuItem,
    HlmDropdownMenuTrigger,
    TrnSpinnerComponent,
    TrnTooltip,
  ],
  templateUrl: './composer-insert-menu.component.html',
  styleUrl: './composer-insert-menu.component.scss',
})
export class ComposerInsertMenuComponent {
  private readonly actionSheet = inject(TrnActionSheetService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly mobileTrigger =
    viewChild<ElementRef<HTMLButtonElement>>('mobileTrigger');

  /** iOS/Android interaction model, including mobile web/PWAs; Electron is excluded. */
  protected readonly mobileInteraction = isMobileOs();
  protected readonly mobileSheetOpen = signal(false);
  private ownedSheet: OwnedSheet | null = null;

  /** Whether the `+` opens a tray rather than acting as a plain attach button. */
  readonly hasMenu = input(false);
  /** Room/thread identity; changing it invalidates an open sheet's action snapshot. */
  readonly contextKey = input<string | null>(null);
  /** Edit mode disables the whole tray — an edit can't become an attachment. */
  readonly editing = input(false);
  /** Whether an attachment upload is in flight (blocks another attachment only). */
  /**
   * A media send is in flight. Gates the items that dispatch IMMEDIATELY — a GIF and a voice
   * clip both go straight out and would collide with it. Attaching is deliberately not gated:
   * a send takes the whole staged batch, so a file added during one waits for the next press.
   */
  readonly uploading = input(false);
  /** Whether a GIF provider + API key are configured. */
  readonly gifEnabled = input(false);
  /** Whether a chosen GIF is being fetched. */
  readonly gifDownloading = input(false);
  /** Whether the room-scoped rich actions (poll, location, voice) are offered. */
  readonly richActions = input(false);
  /** Whether this device can record voice (mic + MediaRecorder present). */
  readonly voiceSupported = input(false);
  /** Whether a voice message is already being recorded. */
  readonly recording = input(false);
  /** Whether a location is being resolved and sent. */
  readonly locationSharing = input(false);
  /** Whether the active room has at least one sticker-capable image-pack entry. */
  readonly stickerEnabled = input(false);

  readonly attachFile = output<void>();
  readonly pickGif = output<void>();
  readonly createPoll = output<void>();
  readonly shareLocation = output<void>();
  readonly recordVoice = output<void>();
  readonly pickSticker = output<void>();

  /** One action model feeds both the anchored desktop menu and mobile action sheet. */
  protected readonly insertActions = computed<readonly ComposerInsertAction[]>(
    () => {
      const actions: ComposerInsertAction[] = [
        {
          text: 'Attach a file',
          icon: 'paperclip',
          testId: 'insert-attach',
          disabled: false,
          run: () => this.attachFile.emit(),
        },
      ];
      if (this.gifEnabled()) {
        actions.push({
          text: 'GIF',
          icon: 'image-play',
          testId: 'insert-gif',
          disabled: this.uploading() || this.gifDownloading(),
          run: () => this.pickGif.emit(),
        });
      }
      if (this.richActions()) {
        if (this.stickerEnabled()) {
          actions.push({
            text: 'Sticker',
            icon: 'image',
            testId: 'insert-sticker',
            disabled: false,
            run: () => this.pickSticker.emit(),
          });
        }
        actions.push(
          {
            text: 'Poll',
            icon: 'vote',
            testId: 'insert-poll',
            disabled: false,
            run: () => this.createPoll.emit(),
          },
          {
            text: 'Location',
            icon: 'map-pin',
            testId: 'insert-location',
            disabled: this.locationSharing(),
            run: () => this.shareLocation.emit(),
          },
        );
        if (this.voiceSupported() && !this.recording()) {
          actions.push({
            text: 'Voice message',
            icon: 'mic',
            testId: 'insert-voice',
            disabled: this.uploading(),
            run: () => this.recordVoice.emit(),
          });
        }
      }
      return actions;
    },
  );

  constructor() {
    // A sheet is a snapshot. The composer survives room changes and async capability
    // changes, so never leave stale actions standing over a new context.
    effect(() => {
      this.contextKey();
      this.hasMenu();
      this.editing();
      this.uploading();
      this.gifEnabled();
      this.gifDownloading();
      this.richActions();
      this.voiceSupported();
      this.recording();
      this.locationSharing();
      this.stickerEnabled();
      untracked(() => this.closeMobileSheet(false));
    });
    this.destroyRef.onDestroy(() => this.closeMobileSheet(false));
  }

  protected openMobileSheet(): void {
    if (this.editing()) return;
    this.closeMobileSheet(false);

    let invocation: OwnedSheet | null = null;
    const buttons: ActionSheetButton[] = this.insertActions().map((action) => ({
      text: action.text,
      icon: action.icon,
      testId: action.testId,
      disabled: action.disabled,
      handler: () => {
        const current = invocation;
        if (!current) return;
        current.picked = true;
        if (this.ownedSheet === current) {
          this.ownedSheet = null;
          this.mobileSheetOpen.set(false);
        }
        action.run();
      },
    }));
    const ref = this.actionSheet.open(
      { header: 'Add to message', buttons },
      'Add to message',
      // Selection can open a poll, GIF or sticker surface. CDK restoring the `+`
      // afterward would steal focus from it, so this opener restores only dismissals.
      { restoreFocus: false },
    );
    const owned: OwnedSheet = {
      ref,
      picked: false,
      restoreOnDismiss: true,
    };
    invocation = owned;
    this.ownedSheet = owned;
    this.mobileSheetOpen.set(true);

    ref.closed.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (this.ownedSheet === owned) {
        this.ownedSheet = null;
        this.mobileSheetOpen.set(false);
      }
      // `TrnActionSheetComponent` closes before it runs the handler. Defer this check
      // one microtask so a chosen action can mark itself before dismissal restoration.
      queueMicrotask(() => {
        if (owned.restoreOnDismiss && !owned.picked) {
          this.mobileTrigger()?.nativeElement.focus();
        }
      });
    });
  }

  private closeMobileSheet(restoreOnDismiss: boolean): void {
    const invocation = this.ownedSheet;
    if (!invocation) return;
    invocation.restoreOnDismiss = restoreOnDismiss;
    invocation.ref.close();
  }
}
