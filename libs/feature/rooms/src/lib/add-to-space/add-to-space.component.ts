import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormField, form } from '@angular/forms/signals';
import { TrnButton } from '@trinity/components/controls';
import { EmptyStateComponent } from '@trinity/components/generic-content';
import { TrnCheckboxComponent } from '@trinity/components/controls';
import { TrnInput } from '@trinity/components/controls';
import {
  TrnDialogActions,
  TrnDialogRef,
  TrnDialogShellComponent,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  SpaceContentsService,
  type SpaceContentsCandidate,
} from '@trinity/data-access/room-library';
import {
  AvatarComponent,
  type AvatarShape,
} from '@trinity/components/generic-content';
import { saveFields, type FieldWrite } from '../shared/save-fields';

/** A room or space offered for adding, flattened so one list can hold both. */
export interface AddCandidate {
  id: string;
  name: string;
  initial: string;
  avatarMxc: string | null;
  isSpace: boolean;
  shape: AvatarShape;
}

/**
 * Dialog to add rooms you are already in to a space.
 *
 * Spaces are offered alongside rooms: nesting a space is the same `m.space.child` write whose
 * target happens to be a space, and the list labels which is which.
 *
 * Multi-select, not add-on-click: each link is its own state event, so committing them
 * together lets one failure be reported against its room instead of "something went wrong".
 */
@Component({
  selector: 'trn-add-to-space',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    EmptyStateComponent,
    FormField,
    TrnButton,
    TrnDialogActions,
    TrnDialogShellComponent,
    TrnCheckboxComponent,
    TrnInput,
    AvatarComponent,
  ],
  templateUrl: './add-to-space.component.html',
  styleUrl: './add-to-space.component.scss',
})
export class AddToSpaceComponent implements OnInit {
  private readonly dialogRef = inject<TrnDialogRef<boolean>>(TrnDialogRef);
  private readonly contents = inject(SpaceContentsService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * The search box. `form` uses the model signal as its source of truth, so `searchModel()`
   * is the live value.
   */
  private readonly searchModel = signal({ query: '' });
  private readonly selected = signal<ReadonlySet<string>>(new Set());
  private readonly candidateState = signal<readonly SpaceContentsCandidate[]>(
    [],
  );

  /** Account that owns the target Space and must perform every link write. */
  readonly accountId = input.required<string>();
  readonly spaceId = input.required<string>();
  readonly spaceName = input('this space');
  readonly search = form(this.searchModel);

  readonly adding = signal(false);
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);

  /**
   * Joined rooms and spaces, minus the target and anything already linked into it. Reads
   * the space's links (synced state), not the hierarchy fetch, so an added room leaves the
   * list as soon as the write echoes back.
   */
  readonly candidates = computed<AddCandidate[]>(() =>
    this.candidateState().map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      initial: candidate.initial,
      avatarMxc: candidate.avatarMxc,
      isSpace: candidate.kind === 'space',
      shape: candidate.direct ? 'person' : 'place',
    })),
  );

  /** {@link candidates} narrowed by the search box. */
  readonly visible = computed(() => {
    const term = this.searchModel().query.trim().toLowerCase();
    if (!term) {
      return this.candidates();
    }
    return this.candidates().filter((candidate) =>
      candidate.name.toLowerCase().includes(term),
    );
  });

  readonly selectedCount = computed(() => this.selected().size);

  ngOnInit(): void {
    this.contents
      .observe({ accountId: this.accountId(), spaceId: this.spaceId() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((snapshot) => {
        this.loading.set(false);
        this.loadError.set(
          snapshot.unavailableReason ?? snapshot.hierarchyError,
        );
        this.candidateState.set(snapshot.candidates);
      });
  }

  isSelected(id: string): boolean {
    return this.selected().has(id);
  }

  toggle(id: string, checked: boolean): void {
    this.selected.update((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  /** Link every selected room into the space, reporting what did and didn't land. */
  add(): void {
    const spaceId = this.spaceId();
    const chosen = this.candidates().filter((candidate) =>
      this.selected().has(candidate.id),
    );
    if (chosen.length === 0) {
      this.dialogRef.close(false);
      return;
    }
    const writes: FieldWrite[] = chosen.map((candidate) => ({
      field: candidate.name,
      op: this.contents.link(
        { accountId: this.accountId(), spaceId },
        candidate.id,
      ),
    }));
    this.adding.set(true);
    saveFields(writes)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ saved, failed }) => {
        if (failed.length === 0) {
          this.toast.show(
            saved.length === 1
              ? `Added ${saved[0]} to ${this.spaceName()}.`
              : `Added ${saved.length} rooms to ${this.spaceName()}.`,
            { duration: 3000, variant: 'success' },
          );
          this.dialogRef.close(true);
          return;
        }
        this.adding.set(false);
        this.toast.show(
          saved.length
            ? `Added ${saved.join(' and ')}, but couldn’t add ${failed.join(' and ')}.`
            : `Could not add ${failed.join(' and ')}.`,
          { duration: 4000, variant: 'danger' },
        );
      });
  }

  close(): void {
    this.dialogRef.close(false);
  }
}
