import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormField,
  FormRoot,
  form,
  pattern,
  required,
} from '@angular/forms/signals';
import { TrnButton, TrnInput, TrnLabel } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import {
  EmptyStateComponent,
  TrnBadge,
} from '@trinity/components/generic-content';
import {
  TrnAlertService,
  TrnSettingsGroupComponent,
  TrnSurfaceService,
} from '@trinity/components/overlay';
import {
  ImagePackEditError,
  ImagePackEditorService,
  SHORTCODE_PATTERN,
  type PackEntry,
} from '@trinity/data-access/media';
import { TrackFileChooserDirective } from '@trinity/platform-native';
import { concatMap, filter, from, switchMap, type Observable } from 'rxjs';
import {
  AddToPackDialogComponent,
  SHORTCODE_HINT,
  USAGES,
  addFailure,
  type UseAs,
} from '../add-to-pack-dialog/add-to-pack-dialog.component';
import { PackImageComponent } from './pack-image.component';

const MAX_IMAGES = 500;
const CHANGE_FAILED = 'Couldn’t change your emoji. Try again.';
const USE_AS_LABELS: Record<UseAs, string> = {
  emoticon: 'Emoji',
  sticker: 'Sticker',
  both: 'Both',
};
const USE_AS_ACTIONS: Record<UseAs, string> = {
  emoticon: 'Use as emoji',
  sticker: 'Use as sticker',
  both: 'Use as emoji and sticker',
};

function useAsOf(entry: PackEntry): UseAs {
  if (entry.usage.includes('sticker')) {
    return entry.usage.includes('emoticon') ? 'both' : 'sticker';
  }
  return 'emoticon';
}

/** Settings' "Your emoji": the personal image pack as a grid, with add, rename, usage and delete. */
@Component({
  selector: 'trn-personal-pack',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    EmptyStateComponent,
    FormField,
    FormRoot,
    PackImageComponent,
    TrackFileChooserDirective,
    TrnBadge,
    TrnButton,
    TrnIconComponent,
    TrnInput,
    TrnLabel,
    TrnSettingsGroupComponent,
  ],
  templateUrl: './personal-pack.component.html',
})
export class PersonalPackComponent {
  private readonly editor = inject(ImagePackEditorService);
  private readonly surfaces = inject(TrnSurfaceService);
  private readonly alert = inject(TrnAlertService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly renameInput =
    viewChild<ElementRef<HTMLInputElement>>('renameInput');
  private readonly renameModel = signal({ shortcode: '' });
  /** A clash or server error for the shortcode it was raised for. */
  private readonly renameFailure = signal<{
    readonly shortcode: string;
    readonly message: string;
  } | null>(null);

  protected readonly entries = this.editor.personal;
  protected readonly full = computed(
    () => (this.entries()?.length ?? 0) >= MAX_IMAGES,
  );
  protected readonly useAsOf = useAsOf;
  protected readonly labels = USE_AS_LABELS;
  /** The shortcode being renamed, or null. */
  protected readonly renaming = signal<string | null>(null);
  protected readonly renameForm = form(this.renameModel, (path) => {
    required(path.shortcode, { message: SHORTCODE_HINT });
    pattern(path.shortcode, SHORTCODE_PATTERN, { message: SHORTCODE_HINT });
  });
  protected readonly renameError = computed(() => {
    const failure = this.renameFailure();
    if (failure?.shortcode === this.renameModel().shortcode) {
      return failure.message;
    }
    const field = this.renameForm.shortcode();
    return field.touched() ? (field.errors()[0]?.message ?? null) : null;
  });
  protected readonly status = signal('');

  constructor() {
    this.editor.run().pipe(takeUntilDestroyed()).subscribe();
  }

  protected addFiles(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    from(files)
      .pipe(
        concatMap((file) =>
          this.surfaces.openAndWait$<PackEntry, AddToPackDialogComponent>(
            AddToPackDialogComponent,
            {
              inputs: {
                input: { kind: 'file', file },
                suggestedName: file.name,
              },
              autoFocus: '[data-autofocus]',
              dismissGuard: (dialog) => dialog?.canDismiss() ?? true,
            },
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  protected openActions(entry: PackEntry, anchor: HTMLElement): void {
    const code = `:${entry.shortcode}:`;
    const current = useAsOf(entry);
    this.surfaces.openActions(
      {
        header: code,
        buttons: [
          { text: 'Rename shortcode', handler: () => this.startRename(entry) },
          ...(Object.keys(USE_AS_ACTIONS) as UseAs[]).map((useAs, index) => ({
            text: USE_AS_ACTIONS[useAs],
            icon: useAs === current ? ('check' as const) : undefined,
            separatorBefore: index === 0,
            handler: () => this.setUsage(entry, useAs),
          })),
          {
            text: 'Delete',
            variant: 'danger' as const,
            separatorBefore: true,
            handler: () => this.remove(entry),
          },
          { text: 'Cancel', role: 'cancel' as const },
        ],
      },
      { anchor, ariaLabel: code },
    );
  }

  private startRename(entry: PackEntry): void {
    this.renameFailure.set(null);
    this.renameModel.set({ shortcode: entry.shortcode });
    this.renameForm.shortcode().reset();
    this.renaming.set(entry.shortcode);
    // After the closing menu hands focus back to its tile.
    setTimeout(() => this.renameInput()?.nativeElement.focus());
  }

  protected saveRename(): void {
    const from_ = this.renaming();
    if (from_ === null) return;
    if (this.renameForm.shortcode().invalid()) {
      this.renameForm.shortcode().markAsTouched();
      return;
    }
    const to = this.renameModel().shortcode;
    this.renameFailure.set(null);
    this.editor
      .rename(from_, to)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        complete: () => this.renaming.set(null),
        error: (error: unknown) =>
          this.renameFailure.set({
            shortcode: to,
            message:
              error instanceof ImagePackEditError
                ? addFailure(error, to).message
                : CHANGE_FAILED,
          }),
      });
  }

  private setUsage(entry: PackEntry, useAs: UseAs): void {
    if (useAsOf(entry) === useAs) return;
    this.change(this.editor.setUsage(entry.shortcode, USAGES[useAs]));
  }

  private remove(entry: PackEntry): void {
    this.change(
      this.alert
        .confirm$({
          header: `Remove :${entry.shortcode}: from your emoji?`,
          confirmText: 'Remove',
          variant: 'danger',
        })
        .pipe(
          filter(Boolean),
          switchMap(() => this.editor.remove(entry.shortcode)),
        ),
    );
  }

  private change(action: Observable<unknown>): void {
    this.status.set('');
    action.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      error: (error: unknown) =>
        this.status.set(
          error instanceof ImagePackEditError
            ? addFailure(error, '').message
            : CHANGE_FAILED,
        ),
    });
  }
}
