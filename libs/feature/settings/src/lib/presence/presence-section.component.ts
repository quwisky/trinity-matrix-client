import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { TrnButton } from '@trinity/kit/button';
import { TrnInput } from '@trinity/kit/input';
import { TrnLabel } from '@trinity/kit/label';
import {
  TrnRadio,
  TrnRadioGroup,
  TrnRadioIndicator,
} from '@trinity/kit/radio-group';
import { PresenceService } from '@trinity/data-access/profile';
import { presenceLabel, type PresenceState } from '@trinity/util/matrix';
import { runWithBusy } from '@trinity/ui';

/** The presence states a user can set for themselves (Matrix has no "invisible"). */
const PRESENCE_OPTIONS: readonly PresenceState[] = [
  'online',
  'unavailable',
  'offline',
];

/** Longest status message we send — the same 60 the composer/room prompts cap at. */
const MAX_STATUS_LENGTH = 60;

/**
 * Presence settings: set your own online state (Online / Away / Offline) and an
 * optional status message, published via {@link PresenceService.setOwnPresence}
 * (`m.presence`). Complements the presence dots shown for other people.
 */
@Component({
  selector: 'trn-presence-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './presence-section.component.html',
  imports: [
    TrnButton,
    TrnInput,
    TrnLabel,
    TrnRadioGroup,
    TrnRadio,
    TrnRadioIndicator,
  ],
})
export class PresenceSectionComponent {
  private readonly presence = inject(PresenceService);
  private readonly destroyRef = inject(DestroyRef);

  readonly options = PRESENCE_OPTIONS;
  readonly maxLength = MAX_STATUS_LENGTH;

  /** Local drafts, committed on Save; seeded from the server's current state on open. */
  readonly stateDraft = signal<PresenceState>(this.presence.myPresence());
  readonly statusDraft = signal(this.presence.myStatusMessage());
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly justSaved = signal(false);

  /** Whether the draft differs from what's published (enables Save). */
  readonly dirty = computed(
    () =>
      this.stateDraft() !== this.presence.myPresence() ||
      this.statusDraft().trim() !== this.presence.myStatusMessage(),
  );

  constructor() {
    // Seed the form from the signed-in user's current server state.
    this.presence.loadOwnPresence();
    this.stateDraft.set(this.presence.myPresence());
    this.statusDraft.set(this.presence.myStatusMessage());
  }

  /** Human label for a presence state (Online / Away / Offline). */
  labelFor(state: PresenceState): string {
    return presenceLabel(state);
  }

  onStateChange(value: string): void {
    if (this.isPresenceState(value)) {
      this.stateDraft.set(value);
      this.justSaved.set(false);
    }
  }

  onStatusInput(event: Event): void {
    this.statusDraft.set((event.target as HTMLInputElement).value);
    this.justSaved.set(false);
  }

  save(): void {
    runWithBusy(
      this.presence.setOwnPresence(this.stateDraft(), this.statusDraft()),
      { busy: this.saving, error: this.error, destroyRef: this.destroyRef },
    ).subscribe(() => this.justSaved.set(true));
  }

  private isPresenceState(value: string): value is PresenceState {
    return (PRESENCE_OPTIONS as readonly string[]).includes(value);
  }
}
