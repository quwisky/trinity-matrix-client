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
import {
  TrnButton,
  TrnCheckboxComponent,
  TrnInput,
} from '@trinity/components/controls';
import {
  AvatarComponent,
  EmptyStateComponent,
} from '@trinity/components/generic-content';
import { TrnAlertService } from '@trinity/components/overlay';
import {
  SpaceContentsService,
  type CreatedSpaceContent,
  type SpaceContentsItem,
  type SpaceContentsSnapshot,
  type SpaceContentsTarget,
} from '@trinity/data-access/room-library';
import { filter } from 'rxjs';
import { saveFields } from '../shared/save-fields';
import { SpaceSettingsContentsListComponent } from './space-settings-contents-list.component';

interface ContentsFeedback {
  readonly tone: 'success' | 'danger';
  readonly message: string;
}

@Component({
  selector: 'trn-space-settings-contents',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AvatarComponent,
    EmptyStateComponent,
    FormField,
    TrnButton,
    TrnCheckboxComponent,
    TrnInput,
    SpaceSettingsContentsListComponent,
  ],
  templateUrl: './space-settings-contents.component.html',
  styleUrl: './space-settings-contents.component.scss',
})
export class SpaceSettingsContentsComponent implements OnInit {
  private readonly contents = inject(SpaceContentsService);
  private readonly alert = inject(TrnAlertService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly snapshotState = signal<SpaceContentsSnapshot | null>(null);
  private readonly searchModel = signal({ query: '' });
  private readonly selected = signal<ReadonlySet<string>>(new Set());
  private readonly pickerOpenState = signal(false);
  private readonly pendingState = signal<string | null>(null);
  private readonly feedbackState = signal<ContentsFeedback | null>(null);
  private readonly recoveryState = signal<CreatedSpaceContent | null>(null);

  readonly target = input.required<SpaceContentsTarget>();
  readonly spaceName = input('this Space');
  readonly search = form(this.searchModel);
  readonly snapshot = this.snapshotState.asReadonly();
  readonly pickerOpen = this.pickerOpenState.asReadonly();
  readonly pending = this.pendingState.asReadonly();
  readonly feedback = this.feedbackState.asReadonly();
  readonly recovery = this.recoveryState.asReadonly();
  readonly curationBusy = signal(false);
  readonly loading = signal(true);
  readonly actionsBusy = computed(
    () => this.pending() !== null || this.curationBusy(),
  );
  readonly visibleCandidates = computed(() => {
    const term = this.searchModel().query.trim().toLowerCase();
    const candidates = this.snapshot()?.candidates ?? [];
    return term
      ? candidates.filter(
          ({ name, id }) =>
            name.toLowerCase().includes(term) ||
            id.toLowerCase().includes(term),
        )
      : candidates;
  });
  readonly selectedCount = computed(() => this.selected().size);

  ngOnInit(): void {
    this.contents
      .observe(this.target())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((snapshot) => this.publish(snapshot));
  }

  isSelected(id: string): boolean {
    return this.selected().has(id);
  }

  toggle(id: string, checked: boolean): void {
    this.selected.update((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  openPicker(): void {
    if (this.actionsBusy()) return;
    this.feedbackState.set(null);
    this.pickerOpenState.set(true);
  }

  closePicker(): void {
    this.pickerOpenState.set(false);
    this.selected.set(new Set());
    this.searchModel.set({ query: '' });
  }

  addSelected(): void {
    const selected = this.selected();
    const chosen = (this.snapshot()?.candidates ?? []).filter(({ id }) =>
      selected.has(id),
    );
    if (chosen.length === 0 || this.actionsBusy()) return;
    this.pendingState.set('add');
    this.feedbackState.set(null);
    saveFields(
      chosen.map((item) => ({
        field: item.name,
        op: this.contents.link(this.target(), item.id),
      })),
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ saved, failed }) => {
        this.pendingState.set(null);
        if (failed.length === 0) {
          this.feedbackState.set({
            tone: 'success',
            message:
              saved.length === 1
                ? `${saved[0]} added.`
                : `${saved.length} items added.`,
          });
          this.closePicker();
        } else {
          this.feedbackState.set({
            tone: 'danger',
            message: saved.length
              ? `${saved.join(' and ')} added. ${failed.join(' and ')} could not be added.`
              : `${failed.join(' and ')} could not be added.`,
          });
        }
        this.refresh();
      });
  }

  create(kind: CreatedSpaceContent['kind']): void {
    if (this.actionsBusy()) return;
    const noun = kind === 'space' ? 'Space' : 'Room';
    this.alert
      .prompt$({
        header: `Create ${noun}`,
        message:
          kind === 'space'
            ? `Create a nested Space and add it to “${this.spaceName()}”.`
            : `Create an encrypted Room and add it to “${this.spaceName()}”.`,
        placeholder: `${noun} name`,
        confirmText: 'Create',
        maxLength: 100,
      })
      .pipe(
        filter((name): name is string => name !== null),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((name) => this.runCreate(kind, name));
  }

  unlink(item: SpaceContentsItem): void {
    if (this.actionsBusy()) return;
    this.alert
      .confirm$({
        header: `Remove ${item.kind === 'space' ? 'Space' : 'Room'} from Space`,
        message: `Remove “${item.name}” from “${this.spaceName()}”? This only unlinks it. You stay joined, and the ${item.kind === 'space' ? 'Space' : 'Room'} is not deleted.`,
        confirmText: 'Remove',
        variant: 'danger',
      })
      .pipe(filter(Boolean), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.runUnlink(item));
  }

  retryLink(): void {
    const item = this.recovery();
    if (!item || this.actionsBusy()) return;
    this.pendingState.set(`retry:${item.id}`);
    this.feedbackState.set(null);
    this.contents
      .link(this.target(), item.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.pendingState.set(null);
          this.recoveryState.set(null);
          this.feedbackState.set({
            tone: 'success',
            message: `${item.name} added without creating another ${item.kind === 'space' ? 'Space' : 'Room'}.`,
          });
          this.refresh();
        },
        error: (error: unknown) => {
          this.pendingState.set(null);
          this.feedbackState.set({
            tone: 'danger',
            message: `The ${item.kind === 'space' ? 'Space' : 'Room'} still exists, but linking failed: ${messageOf(error)}`,
          });
        },
      });
  }

  refresh(): void {
    this.loading.set(true);
    this.contents
      .read(this.target())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((snapshot) => this.publish(snapshot));
  }

  private runCreate(kind: CreatedSpaceContent['kind'], name: string): void {
    if (!name.trim()) return;
    this.pendingState.set(`create:${kind}`);
    this.feedbackState.set(null);
    this.contents
      .create(this.target(), kind, name)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => {
          this.pendingState.set(null);
          if (result.kind === 'created-unlinked') {
            this.recoveryState.set(result.item);
            this.feedbackState.set({
              tone: 'danger',
              message: `${result.item.name} was created as ${result.item.id}, but could not be added: ${result.reason}`,
            });
          } else {
            this.recoveryState.set(null);
            this.feedbackState.set({
              tone: 'success',
              message: `${result.item.name} created and added.`,
            });
          }
          this.refresh();
        },
        error: (error: unknown) => {
          this.pendingState.set(null);
          this.feedbackState.set({
            tone: 'danger',
            message: `${kind === 'space' ? 'Space' : 'Room'} could not be created: ${messageOf(error)}`,
          });
        },
      });
  }

  private runUnlink(item: SpaceContentsItem): void {
    this.pendingState.set(`unlink:${item.id}`);
    this.feedbackState.set(null);
    this.contents
      .unlink(this.target(), item.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.pendingState.set(null);
          this.feedbackState.set({
            tone: 'success',
            message: `${item.name} removed from ${this.spaceName()}. Membership was not changed.`,
          });
          this.refresh();
        },
        error: (error: unknown) => {
          this.pendingState.set(null);
          this.feedbackState.set({
            tone: 'danger',
            message: `${item.name} could not be removed: ${messageOf(error)}`,
          });
        },
      });
  }

  private publish(snapshot: SpaceContentsSnapshot): void {
    this.snapshotState.set(snapshot);
    this.loading.set(false);
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
