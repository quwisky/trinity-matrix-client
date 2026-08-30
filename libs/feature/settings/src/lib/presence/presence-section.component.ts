import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import { TrnInput } from '@trinity/components/controls';
import { TrnLabel } from '@trinity/components/controls';
import {
  TrnRadioGroupComponent,
  type TrnRadioOption,
} from '@trinity/components/controls';
import { IdentityPresenceService } from '@trinity/data-access/identity';
import { presenceLabel, type PresenceState } from '@trinity/util/matrix';
import { runWithBusy } from '@trinity/util/ui';
import { SettingsSectionHeadingComponent } from '../shared/settings-section-heading.component';

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
 * optional status message, published via {@link IdentityPresenceService.setOwnPresence}
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
    TrnRadioGroupComponent,
    SettingsSectionHeadingComponent,
  ],
})
export class PresenceSectionComponent {
  private readonly presence = inject(IdentityPresenceService);
  private readonly destroyRef = inject(DestroyRef);

  /** The same states, in the shape the radio group takes. */
  readonly presenceOptions: readonly TrnRadioOption<PresenceState>[] =
    PRESENCE_OPTIONS.map((state) => ({
      value: state,
      label: presenceLabel(state),
      testId: `presence-${state}`,
    }));
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
