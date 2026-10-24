import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
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
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  ImagePackEditError,
  ImagePackEditorService,
  MAX_PERSONAL_IMAGES,
  SHORTCODE_PATTERN,
  type PackEntry,
  type PackRef,
} from '@trinity/data-access/media';
import { TrackFileChooserDirective } from '@trinity/platform-native';
import {
  EMPTY,
  catchError,
  concatMap,
  distinctUntilChanged,
  filter,
  finalize,
  from,
  map,
  switchMap,
  type Observable,
} from 'rxjs';
import {
  AddToPackDialogComponent,
  PACK_COPY,
  PERSONAL_PACK,
  SHORTCODE_HINT,
  USAGES,
  addFailure,
  type UseAs,
} from '../add-to-pack-dialog/add-to-pack-dialog.component';
import { PackImageComponent } from './pack-image.component';

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

/** Copy for a failed rename, usage change or delete. */
function changeFailure(
  error: unknown,
  shortcode: string,
  kind: PackRef['kind'],
): string {
  if (error instanceof ImagePackEditError) {
    if (error.code === 'not-signed-in') return PACK_COPY[kind].signInToChange;
    if (error.code === 'not-allowed') return PACK_COPY[kind].notAllowed;
    if (
      error.code === 'shortcode-taken' ||
      error.code === 'invalid-shortcode'
    ) {
      return addFailure(error, shortcode, kind).message;
    }
  }
  return PACK_COPY[kind].changeFailed;
}

function packKey(ref: PackRef): string {
  return ref.kind === 'personal' ? '' : `${ref.accountId} ${ref.roomId}`;
}

function useAsOf(entry: PackEntry): UseAs {
  if (entry.usage.includes('sticker')) {
    return entry.usage.includes('emoticon') ? 'both' : 'sticker';
  }
  return 'emoticon';
}

/**
 * Settings' "Your emoji", or with a room `ref` a room's own emoji: the pack as a grid, with add,
 * rename, usage and delete. Room settings loads it through `IMAGE_PACK_EDITOR`.
 */
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
  private readonly matrix = inject(MatrixClientService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** A renamed shortcode whose tile takes focus once the pack shows it. */
  private readonly focusPending = signal<string | null>(null);
  private renameRunning = false;
  private readonly renameInput =
    viewChild<ElementRef<HTMLInputElement>>('renameInput');
  private readonly renameModel = signal({ shortcode: '' });
  /** A clash or server error for the shortcode it was raised for. */
  private readonly renameFailure = signal<{
    readonly shortcode: string;
    readonly message: string;
  } | null>(null);

  private readonly roomEntries = signal<readonly PackEntry[] | null>(null);

  /** Why a room's pack could not be shown. */
  protected readonly loadFailure = signal<string | null>(null);

  protected readonly copy = computed(() => PACK_COPY[this.ref().kind]);
  protected readonly entries = computed(() =>
    this.ref().kind === 'personal'
      ? this.editor.personal()
      : this.roomEntries(),
  );
  protected readonly full = computed(
    () => (this.entries()?.length ?? 0) >= MAX_PERSONAL_IMAGES,
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

  readonly ref = input<PackRef>(PERSONAL_PACK);
  /** A room ref's room is encrypted, so the editor notes that its images are not. */
  readonly encrypted = input(false);

  constructor() {
    toObservable(this.ref)
      .pipe(
        // Room settings rebuilds the ref when the room's encryption changes; keep the grid.
        distinctUntilChanged((a, b) => packKey(a) === packKey(b)),
        switchMap((ref) => {
          this.roomEntries.set(null);
          this.loadFailure.set(null);
          return ref.kind === 'personal'
            ? this.editor.run()
            : this.editor.entries$(ref).pipe(
                map((entries) => this.roomEntries.set(entries)),
                catchError((error: unknown) => {
                  this.loadFailure.set(changeFailure(error, '', ref.kind));
                  return EMPTY;
                }),
              );
        }),
        takeUntilDestroyed(),
      )
      .subscribe();
    effect(() => {
      const code = this.focusPending();
      if (code && this.entries()?.some((entry) => entry.shortcode === code)) {
        this.focusPending.set(null);
        this.focusTile(code);
      }
    });
  }

  protected addFiles(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    const account = this.matrix.activeUserId();
    from(files)
      .pipe(
        // For the personal pack, an account switch drops the files still queued; the open dialog
        // closes itself. A room ref pins its account.
        concatMap((file) =>
          this.ref().kind === 'personal' &&
          this.matrix.activeUserId() !== account
            ? EMPTY
            : this.surfaces.openAndWait$<PackEntry, AddToPackDialogComponent>(
                AddToPackDialogComponent,
                {
                  inputs: {
                    input: { kind: 'file', file },
                    suggestedName: file.name,
                    ref: this.ref(),
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

  protected cancelRename(): void {
    const original = this.renaming();
    this.renaming.set(null);
    if (original !== null) this.focusTile(original);
  }

  protected saveRename(): void {
    const original = this.renaming();
    if (original === null || this.renameRunning) return;
    if (this.renameForm.shortcode().invalid()) {
      this.renameForm.shortcode().markAsTouched();
      return;
    }
    const to = this.renameModel().shortcode;
    this.renameFailure.set(null);
    this.renameRunning = true;
    this.editor
      .rename(original, to, this.ref())
      .pipe(
        finalize(() => (this.renameRunning = false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        // Not `complete`: takeUntilDestroyed completes the stream on destroy too.
        next: () => {
          this.renaming.set(null);
          // Add images holds focus until the pack's echo renders the renamed tile.
          this.focusTile(to);
          this.focusPending.set(to);
        },
        error: (error: unknown) => {
          this.renameFailure.set({
            shortcode: to,
            message: changeFailure(error, to, this.ref().kind),
          });
          this.renameInput()?.nativeElement.focus();
        },
      });
  }

  private setUsage(entry: PackEntry, useAs: UseAs): void {
    if (useAsOf(entry) === useAs) return;
    this.change(
      this.editor.setUsage(entry.shortcode, USAGES[useAs], this.ref()),
      entry.shortcode,
    );
  }

  private remove(entry: PackEntry): void {
    this.change(
      this.alert
        .confirm$({
          header: this.copy().remove(entry.shortcode),
          confirmText: 'Remove',
          variant: 'danger',
        })
        .pipe(
          filter(Boolean),
          switchMap(() => this.editor.remove(entry.shortcode, this.ref())),
        ),
      entry.shortcode,
    );
  }

  private change(action: Observable<unknown>, shortcode: string): void {
    this.status.set('');
    action.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      error: (error: unknown) =>
        this.status.set(changeFailure(error, shortcode, this.ref().kind)),
    });
  }

  /** Focuses the tile for `code` after the next render, or Add images without one. */
  private focusTile(code: string): void {
    afterNextRender(
      () => {
        const host = this.host.nativeElement;
        (
          host.querySelector<HTMLElement>(`[aria-label=":${code}:"]`) ??
          host.querySelector('button')
        )?.focus();
      },
      { injector: this.injector },
    );
  }
}
