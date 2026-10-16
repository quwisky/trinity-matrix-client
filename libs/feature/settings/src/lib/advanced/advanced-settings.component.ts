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
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { TrnButton } from '@trinity/components/controls';
import { TrnLabel } from '@trinity/components/controls';
import { TrnTextarea } from '@trinity/components/controls';
import {
  AppConfigService,
  CONFIG_EXCLUSION_NOTES,
  describeConfigChange,
  type ConfigApplyPlan,
  TrackFileChooserDirective,
} from '@trinity/platform-native';
import { HostFileExportService } from '@trinity/runtime/host';
import {
  CONFIG_EDITOR_LOADER,
  supportsConfigEditor,
  type ConfigEditorHost,
} from './config-editor-loader';
import { ConfigEditorOutletDirective } from './config-editor-outlet.directive';
import {
  CLIPBOARD_UNREADABLE_MESSAGE,
  readClipboardConfig$,
  readPickedConfigFile$,
} from './import-config';
import { AdvancedSettingsResetService } from './advanced-settings-reset.service';
import { ConfigApplyReviewComponent } from './config-apply-review.component';
import { ConfigResetGroupComponent } from './config-reset-group.component';
import { DiagnosticsGroupComponent } from './diagnostics-group/diagnostics-group.component';
import { defer, filter, throwError } from 'rxjs';
import {
  TrnSettingsGroupComponent,
  TrnToastService,
} from '@trinity/components/overlay';

/** Two digits, so the dated filename sorts lexically. */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Dated filename, so two exports don't overwrite each other.
 *
 * Uses the local calendar fields, not `toISOString()`: a UTC date is a day out around midnight.
 */
function exportFileName(now: Date): string {
  return `trinity-settings-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}

/**
 * Advanced settings: the local preference layer as one pretty-printed JSON document that can
 * be copied, exported, edited, imported and applied back.
 *
 * {@link AppConfigService} builds the document from registered settings only, so accounts,
 * tokens, drafts and server-held data are structurally excluded. The page states this
 * ({@link CONFIG_EXCLUSION_NOTES}) because it is a preferences transfer, not a sign-in.
 *
 * Two rules keep the editor honest:
 * - The box detaches the moment it is dirty. The live document re-renders on any preference
 *   change (theme following the system, another tab, an apply), which would overwrite typing.
 *   So {@link draft} holds the user's text, and while it is non-null the box ignores the live
 *   document; apply or discard resets it to null.
 * - Nothing is written from unchecked text. Apply validates the whole document and writes the
 *   resulting plan, not the text; any edit discards the plan on screen, so a summary never
 *   describes a different document.
 *
 * On web and desktop the box is a rich editor from {@link CONFIG_EDITOR_LOADER}, a dynamic
 * import of ~430 kB that no other settings page pays for. The `<textarea>` renders while that
 * chunk loads, if it never arrives (a service worker holds it lazily, so an offline first
 * visit has none), and read-only on the mobile app, where a phone keyboard is a worse way to
 * change a setting than its own switch. The text belongs to this component either way.
 */
@Component({
  selector: 'trn-advanced-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './advanced-settings.component.html',
  host: { class: 'block' },
  providers: [AdvancedSettingsResetService],
  imports: [
    TrackFileChooserDirective,
    TrnSettingsGroupComponent,
    ConfigEditorOutletDirective,
    ConfigApplyReviewComponent,
    ConfigResetGroupComponent,
    DiagnosticsGroupComponent,
    TrnButton,
    TrnLabel,
    TrnTextarea,
  ],
})
export class AdvancedSettingsComponent {
  private readonly config = inject(AppConfigService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly files = inject(HostFileExportService);

  /** The rich editor where the platform offers one; without it the textarea still edits. */
  private readonly editorLoader = inject(CONFIG_EDITOR_LOADER, {
    optional: true,
  });

  private readonly fileInput =
    viewChild<ElementRef<HTMLInputElement>>('configFile');

  /** The user's own text, or null while the box follows the app (the dirty-state rule). */
  private readonly draft = signal<string | null>(null);

  /** The last plan {@link apply} produced, awaiting confirmation; any edit clears it. */
  private readonly reviewed = signal<ConfigApplyPlan | null>(null);

  /** What the export leaves out and why — the section's copy, not a hardcoded list. */
  readonly exclusions = CONFIG_EXCLUSION_NOTES;

  private readonly fileSupport = toSignal(this.files.support(), {
    initialValue: { kind: 'unavailable', reason: 'not-implemented' } as const,
  });

  /** File export is offered only when the selected host operation reports support. */
  readonly canExportFile = computed(
    () => this.fileSupport().kind === 'supported',
  );

  /**
   * Whether this platform offers editing: web and desktop, not mobile (see
   * {@link supportsConfigEditor}, which also explains why Electron counts as desktop).
   * Read-only elsewhere, with the section saying why, since document, Copy and Reset still help.
   */
  readonly canEdit = supportsConfigEditor();

  /** The editor component, once its chunk has arrived; null until then, and on native. */
  readonly editor = signal<Type<ConfigEditorHost> | null>(null);

  /** True while an apply is in flight; the review disables Apply and Cancel meanwhile. */
  readonly applying = signal(false);

  /**
   * The document, live: re-renders when a preference changes elsewhere or is reset here.
   *
   * Display only. Copy and Export use {@link outgoingDocument}, because `exportedAt` is
   * stamped at read time and a memoized string would freeze it at the last re-render.
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
   * Held apart from {@link reviewed} so they survive the apply that clears the summary: a
   * "desktop-only" warning is needed after pressing Apply. Warn and proceed; don't filter.
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
      load()
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (component) => this.editor.set(component),
          // Offline on a first visit (a service worker holds the chunk lazily) or a moved
          // deploy. The textarea is a complete editing surface: nothing to report or retry.
          error: () => this.editor.set(null),
        });
    }
  }

  /** Copy the document, toasting only once the write resolves — never on a rejection. */
  copy(): void {
    defer(() => {
      const write = navigator.clipboard?.writeText.bind(navigator.clipboard);
      return write
        ? write(this.outgoingDocument())
        : throwError(() => new Error('Clipboard writing is unavailable'));
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.toast.show('Settings copied.', { duration: 2000 }),
        error: () =>
          this.toast.show('Could not copy your settings.', {
            duration: 3000,
            variant: 'danger',
          }),
      });
  }

  /** Save the document through the selected cold host operation. */
  exportFile(): void {
    this.files
      .save({
        bytes: new Blob([this.outgoingDocument()], {
          type: 'application/json',
        }),
        filename: exportFileName(new Date()),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (outcome) => {
          if (outcome.kind !== 'completed' && outcome.kind !== 'cancelled') {
            this.toast.show('Could not export your settings.', {
              duration: 3000,
              variant: 'danger',
            });
          }
        },
        error: () =>
          this.toast.show('Could not export your settings.', {
            duration: 3000,
            variant: 'danger',
          }),
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
   * Check what is in the box and say what applying it would do; writes nothing. The Apply
   * button runs this, and the summary must be confirmed ({@link confirmApply}) before
   * anything moves.
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
          // Follow the app again: applied settings are now the app's own, so the live
          // document is the only honest view.
          this.draft.set(null);
          this.toast.show(
            count === 1 ? '1 setting applied.' : `${count} settings applied.`,
            { duration: 3000, variant: 'success' },
          );
        },
        error: () => {
          this.applying.set(false);
          // Keep the edit: some writes may have landed, and Apply again re-checks against the
          // app as it now is, so the next summary names what still hasn't gone in.
          this.reviewed.set(null);
          this.toast.show('Could not apply every setting.', {
            duration: 4000,
            variant: 'danger',
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
  importFile(event: Event): void {
    readPickedConfigFile$(event)
      .pipe(
        filter((text): text is string => text !== null),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((text) => this.loadAndReview(text));
  }

  /** Load the clipboard into the box and check it — the primary route on mobile. */
  importClipboard(): void {
    readClipboardConfig$()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((text) => {
        if (text === null) {
          this.toast.show(CLIPBOARD_UNREADABLE_MESSAGE, {
            duration: 4000,
            variant: 'danger',
          });
          return;
        }
        this.loadAndReview(text);
      });
  }

  /**
   * What leaves the app on Copy or Export. Dirty: the user's own text, verbatim (a re-read
   * would send settings other than the ones on screen). Otherwise a fresh read, not
   * {@link configJson}, whose `exportedAt` froze at the last re-render.
   */
  private outgoingDocument(): string {
    return this.draft() ?? this.config.exportJson();
  }

  /** Imported text lands in the box like a paste and is checked at once, as a hand edit is. */
  private loadAndReview(text: string): void {
    this.draft.set(text);
    this.review();
  }

  private clearReview(): void {
    this.reviewed.set(null);
    this.warnings.set([]);
  }
}
