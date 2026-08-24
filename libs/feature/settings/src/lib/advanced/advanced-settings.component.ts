import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
  type Type,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Capacitor } from '@capacitor/core';
import { HlmButton } from '@trinity/helm/button';
import { TrnLabel } from '@trinity/components/label';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import { TrnTextarea } from '@trinity/components/textarea';
import {
  AppConfigService,
  CONFIG_EXCLUSION_NOTES,
  describeConfigChange,
  type ConfigApplyPlan,
} from '@trinity/platform-native';
import { downloadTextFile } from '../download-text-file';
import {
  CONFIG_EDITOR_LOADER,
  supportsConfigEditor,
  type ConfigEditorHost,
} from './config-editor-loader';
import { ConfigEditorOutletDirective } from './config-editor-outlet.directive';
import {
  CLIPBOARD_UNREADABLE_MESSAGE,
  readClipboardConfig,
  readPickedConfigFile,
} from './import-config';
import {
  RESET_CONFIG_MISTYPED_MESSAGE,
  confirmResetConfigIntent,
} from './reset-config';

/** Two digits, so the dated filename sorts lexically. */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Name of the downloaded file — dated, so two exports don't overwrite each other.
 *
 * The date is the user's, read from the local calendar fields rather than
 * `toISOString()`: a UTC date is a day out either side of midnight for most of the world,
 * and this name is what someone scans a downloads folder for.
 */
function exportFileName(now: Date): string {
  return `trinity-settings-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}

/**
 * Advanced settings: the whole local preference layer as one pretty-printed JSON document,
 * which can be copied, exported, edited, imported and applied back.
 *
 * The document comes from {@link AppConfigService}, which builds it from the registered
 * settings only, so the omissions are structural rather than filtered: accounts, tokens,
 * drafts and anything the server keeps for you cannot reach it. Those omissions are stated
 * on the page ({@link CONFIG_EXCLUSION_NOTES}) rather than left to be discovered, because
 * someone copying this to a new device needs to know it is a preferences transfer, not a
 * sign-in.
 *
 * ## The two rules that keep this surface honest
 *
 * **The editor detaches the moment it is dirty.** The document is derived from the owning
 * services' signals, so it re-renders whenever any preference changes — which is right for a
 * read-only view and fatal for an editable one, since a preference changing anywhere (a
 * theme following the system, another tab, an apply landing) would overwrite what is being
 * typed. So {@link draft} holds the user's own text, and while it is non-null the box shows
 * that and ignores the live document entirely. Applying or discarding puts it back to null,
 * and the view starts following the app again. There is no third state: the box is either
 * a window onto the app or the user's own text.
 *
 * **Nothing is written from text that was not checked.** Apply validates the whole document
 * first, and the plan it produces is what gets written — not the text. Editing the box
 * throws away any plan that was on screen, so a summary can never belong to a document other
 * than the one shown.
 *
 * ## Two boxes, one document
 *
 * On web and desktop the box is a real editor — completion over the settings the registry
 * knows, hover text from their descriptions, and the Apply gate's own verdict underlined as
 * you type. It arrives through {@link CONFIG_EDITOR_LOADER}, a dynamic import, so its ~430 kB
 * is a chunk of its own that nothing else on any settings page pays for.
 *
 * The `<textarea>` is not dead weight behind it. It is what renders while that chunk is in
 * flight, what renders if it never arrives — a service worker holding the editor lazily by
 * design means an offline first visit has no chunk to load — and what renders on the mobile
 * app, read-only, where a JSON editor over a phone keyboard is a worse way to change a setting
 * than the switch that owns it. Either way the text is this component's, not the box's, so
 * everything below works the same whichever one is on screen.
 */
@Component({
  selector: 'trn-advanced-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './advanced-settings.component.html',
  host: { class: 'block' },
  imports: [ConfigEditorOutletDirective, HlmButton, TrnLabel, TrnTextarea],
})
export class AdvancedSettingsComponent {
  private readonly config = inject(AppConfigService);
  private readonly alert = inject(TrnAlertService);
  private readonly toast = inject(TrnToastService);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * The rich editor, where this platform offers one and the app wired it up. Optional in the
   * `ENCRYPTION_DIALOG_COMPONENTS` idiom: without it the section still renders and still
   * edits, in its textarea.
   */
  private readonly editorLoader = inject(CONFIG_EDITOR_LOADER, {
    optional: true,
  });

  private readonly fileInput =
    viewChild<ElementRef<HTMLInputElement>>('configFile');

  /**
   * The user's own text, or null while the box is following the app. See the class comment:
   * this is the whole of the dirty-state rule.
   */
  private readonly draft = signal<string | null>(null);

  /**
   * The last plan {@link apply} produced, awaiting confirmation. Cleared by any edit, so the
   * summary on screen always describes the text on screen.
   */
  private readonly reviewed = signal<ConfigApplyPlan | null>(null);

  /** What the export leaves out and why — the section's copy, not a hardcoded list. */
  readonly exclusions = CONFIG_EXCLUSION_NOTES;

  /**
   * Native WebViews lack a reliable file download, so the file path is web/desktop only —
   * the same reason recorded at `recovery-key-display.component.ts`. Capacitor reports the
   * Electron shell as non-native, which is correct here: it downloads like a browser.
   * Importing is offered everywhere: picking a file works in a WebView, saving one does not.
   */
  readonly canExportFile = !Capacitor.isNativePlatform();

  /**
   * Whether this platform offers editing at all — web and desktop, not the mobile app. See
   * {@link supportsConfigEditor} for why, and for why the Electron shell counts as desktop
   * even though Capacitor calls it non-native.
   *
   * Read-only elsewhere rather than absent: the document, Copy and Reset are the useful half
   * on a phone, and the section says why the other half is missing rather than leaving a gap.
   */
  readonly canEdit = supportsConfigEditor();

  /** The editor component, once its chunk has arrived; null until then, and on native. */
  readonly editor = signal<Type<ConfigEditorHost> | null>(null);

  /** True while a reset is in flight, so the button can't be pressed twice. */
  readonly resetting = signal(false);

  /** True while an apply is in flight, for the same reason. */
  readonly applying = signal(false);

  /**
   * The document, live: `exportJson()` reads the owning services' signals, so a preference
   * changed elsewhere (or reset here) re-renders this without a reload.
   *
   * What is rendered, only. Copy and Export go through {@link outgoingDocument} instead of
   * sending this string, because `exportedAt` is stamped at the moment of the read: memoized
   * here it would freeze at the last re-render, and a file opened at 17:00 would claim it was
   * taken at 09:00 while its own filename said today. The settings are identical either way —
   * both reads go to the same signals.
   */
  readonly configJson = computed(() => this.config.exportJson());

  /** What the box shows — the user's text once it is dirty, the live document until then. */
  readonly editorValue = computed(() => this.draft() ?? this.configJson());

  /** True once the box holds the user's own text rather than the app's. */
  readonly edited = computed(() => this.draft() !== null);

  /** Why the document was refused, each line naming the path that refused it. */
  readonly problems = computed(() => {
    const plan = this.reviewed();
    return plan && !plan.ok ? plan.problems : [];
  });

  /**
   * Settings that will be applied but do nothing here, and paths this build does not have.
   *
   * Held separately from {@link reviewed} so they survive the apply that clears the summary:
   * "this shortcut is desktop-only" is exactly the thing someone needs to still be able to
   * read *after* pressing Apply. Decision 4 on the issue — warn and proceed, naming what
   * will not apply here, rather than silently filtering.
   */
  readonly warnings = signal<readonly string[]>([]);

  /** The change summary: one line per setting that would move, and where to. */
  readonly changeLines = computed(() => {
    const plan = this.reviewed();
    return plan?.ok ? plan.changes.map(describeConfigChange) : [];
  });

  /** True when the document was readable and already matches the app exactly. */
  readonly nothingToChange = computed(() => {
    const plan = this.reviewed();
    return !!plan?.ok && plan.changes.length === 0;
  });

  constructor() {
    const load = this.editorLoader;
    if (load) {
      void load().then(
        (component) => this.editor.set(component),
        // The chunk did not arrive: offline on a first visit, since it is held lazily by the
        // service worker precisely so it is not downloaded by people who never open this
        // page, or a deploy that moved it. The textarea is a complete editing surface, so
        // there is nothing to report and nothing to retry.
        () => this.editor.set(null),
      );
    }
  }

  /** Copy the document, toasting only once the write resolves — never on a rejection. */
  copy(): void {
    void (
      navigator.clipboard?.writeText(this.outgoingDocument()) ??
      Promise.reject()
    ).then(
      () => this.toast.show('Settings copied.', { duration: 2000 }),
      () =>
        this.toast.show('Could not copy your settings.', {
          duration: 3000,
          variant: 'destructive',
        }),
    );
  }

  /** Save the document as a file (web + desktop only; see {@link canExportFile}). */
  exportFile(): void {
    downloadTextFile(this.document, {
      name: exportFileName(new Date()),
      mimeType: 'application/json',
      content: this.outgoingDocument(),
    });
  }

  /** Take the box over from the live document, and drop any summary that described it. */
  onEditText(text: string): void {
    this.draft.set(text);
    this.clearReview();
  }

  /** The same edit, arriving from the textarea rather than from the editor. */
  onEdit(event: Event): void {
    this.onEditText((event.target as HTMLTextAreaElement).value);
  }

  /** Give the box back to the live document, dropping the edit. */
  discard(): void {
    this.draft.set(null);
    this.clearReview();
  }

  /**
   * Check what is in the box and say what applying it would do. Writes nothing — this is
   * what the Apply button runs, and the summary it produces has to be confirmed
   * ({@link confirmApply}) before anything moves.
   */
  review(): void {
    const plan = this.config.validateJson(this.editorValue());
    this.reviewed.set(plan);
    this.warnings.set(plan.warnings);
  }

  /** Write the reviewed plan through the owning services, so the app follows immediately. */
  confirmApply(): void {
    const plan = this.reviewed();
    if (!plan?.ok || plan.changes.length === 0) {
      return;
    }

    const count = plan.changes.length;
    this.applying.set(true);
    this.config
      .apply(plan)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.applying.set(false);
          this.reviewed.set(null);
          // Back to following the app: the settings the document asked for are now the
          // app's own, and anything a warning named is not — so the live document is the
          // only honest thing to show.
          this.draft.set(null);
          this.toast.show(
            count === 1 ? '1 setting applied.' : `${count} settings applied.`,
            { duration: 3000, variant: 'success' },
          );
        },
        error: () => {
          this.applying.set(false);
          // The edit is kept deliberately: some writes may have landed and some not, and
          // pressing Apply again re-checks against the app as it now is, so the next
          // summary names exactly what still has not gone in.
          this.reviewed.set(null);
          this.toast.show('Could not apply every setting.', {
            duration: 4000,
            variant: 'destructive',
          });
        },
      });
  }

  /** Drop the summary without writing anything; the text in the box is left alone. */
  cancelApply(): void {
    this.clearReview();
  }

  /** Open the file picker for a previously-exported document. */
  pickFile(): void {
    this.fileInput()?.nativeElement.click();
  }

  /** Load a picked file into the box and check it, the same path as a paste. */
  async importFile(event: Event): Promise<void> {
    const text = await readPickedConfigFile(event);
    if (text !== null) {
      this.loadAndReview(text);
    }
  }

  /** Load the clipboard into the box and check it — the primary route on mobile. */
  async importClipboard(): Promise<void> {
    const text = await readClipboardConfig();
    if (text === null) {
      this.toast.show(CLIPBOARD_UNREADABLE_MESSAGE, {
        duration: 4000,
        variant: 'destructive',
      });
      return;
    }
    this.loadAndReview(text);
  }

  /** Put every exported setting back to its default, behind the type-to-confirm gate. */
  async reset(): Promise<void> {
    const intent = await confirmResetConfigIntent(this.alert);
    if (intent === 'cancelled') {
      return;
    }
    if (intent === 'mistyped') {
      this.toast.show(RESET_CONFIG_MISTYPED_MESSAGE, { duration: 4000 });
      return;
    }

    this.resetting.set(true);
    this.config
      .resetToDefaults()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.resetting.set(false);
          // A reset is an edit of the app, not of the box: show what the app now holds.
          this.discard();
          this.toast.show('Settings reset to defaults.', {
            duration: 3000,
            variant: 'success',
          });
        },
        error: () => {
          this.resetting.set(false);
          this.toast.show('Could not reset every setting.', {
            duration: 4000,
            variant: 'destructive',
          });
        },
      });
  }

  /**
   * An imported document lands in the box like a paste — visible and editable before it is
   * applied — and is checked straight away, so file and clipboard reach the same summary a
   * hand edit does.
   */
  /**
   * What leaves the app when Copy or Export is pressed.
   *
   * The two rules meet here. Once the box is dirty it is the user's own text, sent verbatim:
   * re-reading would send the app's settings under the nose of someone who is looking at
   * theirs, and there is nothing to re-stamp in text this component did not write. Until
   * then it is a *fresh* read rather than {@link configJson}, whose `exportedAt` froze at the
   * last re-render — see the note there.
   */
  private outgoingDocument(): string {
    return this.draft() ?? this.config.exportJson();
  }

  private loadAndReview(text: string): void {
    this.draft.set(text);
    this.review();
  }

  private clearReview(): void {
    this.reviewed.set(null);
    this.warnings.set([]);
  }
}
