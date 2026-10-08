import type { Signal } from '@angular/core';
import type { FieldTree } from '@angular/forms/signals';
import type {
  RoomSettingsPermissions,
  RoomSettingsSnapshot,
} from '@trinity/data-access/room-administration';
import type { SettingsFeedback } from '../save-fields';

/** What the shared General form reads and calls on a Room or Space draft service. */
export interface PlaceProfileDraft {
  readonly form: FieldTree<{ name: string; topic: string }>;
  readonly model: Signal<{ readonly name: string; readonly topic: string }>;
  readonly snapshot: Signal<RoomSettingsSnapshot | null>;
  readonly permissions: Signal<RoomSettingsPermissions>;
  readonly mayEditAvatar: Signal<boolean>;
  readonly mayEditName: Signal<boolean>;
  readonly mayEditTopic: Signal<boolean>;
  readonly nameHasPermissionBlockedEdit: Signal<boolean>;
  readonly topicHasPermissionBlockedEdit: Signal<boolean>;
  readonly generalFeedback: Signal<SettingsFeedback | null>;
  readonly generalDirty: Signal<boolean>;
  readonly generalHasWritableChanges: Signal<boolean>;
  readonly generalSaveUnavailableReason: Signal<string | null>;
  readonly saving: Signal<'general' | 'access' | null>;
  /** Spaces only: an emptied name blocks Save and says why. */
  readonly nameEmpty?: Signal<boolean>;
  discardGeneral(): void;
  saveGeneral(): void;
}
