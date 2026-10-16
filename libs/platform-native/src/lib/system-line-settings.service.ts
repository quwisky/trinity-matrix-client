import { Injectable, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import {
  combinePreferenceInitialization,
  preferenceInitializationDefaulted,
  preferenceInitializationReady,
  type PreferenceInitializationOutcome,
  type PreferenceInitializationRead,
} from './preference-initialization';

const MEMBERSHIP_KEY = 'trinity.timeline.show-membership';
const PROFILE_KEY = 'trinity.timeline.show-profile';
const ROOM_CHANGES_KEY = 'trinity.timeline.show-room-changes';

/** Every category of system line is shown unless the user hides it. */
export const DEFAULT_SHOW_MEMBERSHIP = true;
export const DEFAULT_SHOW_PROFILE = true;
export const DEFAULT_SHOW_ROOM_CHANGES = true;

/**
 * Which categories of system line ("Bob joined the room", "Mod changed the room topic") the
 * timeline renders; each can be hidden independently. Per-device and non-secret, so they
 * live in Capacitor `Preferences`. Hiding is purely visual: unread counts come from the
 * server's notification counts and are untouched.
 */
@Injectable({ providedIn: 'root' })
export class SystemLineSettingsService {
  private readonly _showMembership = signal(DEFAULT_SHOW_MEMBERSHIP);
  private readonly _showProfile = signal(DEFAULT_SHOW_PROFILE);
  private readonly _showRoomChanges = signal(DEFAULT_SHOW_ROOM_CHANGES);

  /** Joins, leaves, invites, knocks, kicks/bans/unbans. */
  readonly showMembership = this._showMembership.asReadonly();

  /** Display-name and profile-picture changes by existing members. */
  readonly showProfile = this._showProfile.asReadonly();

  /** Room name, topic, avatar, alias, join rules, history, guest access, encryption. */
  readonly showRoomChanges = this._showRoomChanges.asReadonly();

  /** Read the saved preferences and apply them. Call once at app startup. */
  async init(): Promise<PreferenceInitializationOutcome> {
    const [membership, profile, roomChanges] = await Promise.all([
      this.read(MEMBERSHIP_KEY, DEFAULT_SHOW_MEMBERSHIP),
      this.read(PROFILE_KEY, DEFAULT_SHOW_PROFILE),
      this.read(ROOM_CHANGES_KEY, DEFAULT_SHOW_ROOM_CHANGES),
    ]);
    this._showMembership.set(membership.value);
    this._showProfile.set(profile.value);
    this._showRoomChanges.set(roomChanges.value);
    return combinePreferenceInitialization([
      membership.outcome,
      profile.outcome,
      roomChanges.outcome,
    ]);
  }

  /** Toggle + persist whether membership lines are shown. */
  setShowMembership(on: boolean): void {
    this._showMembership.set(on);
    this.persist(MEMBERSHIP_KEY, on);
  }

  /** Toggle + persist whether profile-change lines are shown. */
  setShowProfile(on: boolean): void {
    this._showProfile.set(on);
    this.persist(PROFILE_KEY, on);
  }

  /** Toggle + persist whether room-state change lines are shown. */
  setShowRoomChanges(on: boolean): void {
    this._showRoomChanges.set(on);
    this.persist(ROOM_CHANGES_KEY, on);
  }

  private async read(
    key: string,
    fallback: boolean,
  ): Promise<PreferenceInitializationRead<boolean>> {
    try {
      const { value } = await Preferences.get({ key });
      if (value === null) {
        return { value: fallback, outcome: preferenceInitializationReady };
      }
      if (value === 'true' || value === 'false') {
        return {
          value: value === 'true',
          outcome: preferenceInitializationReady,
        };
      }
      return {
        value: fallback,
        outcome: preferenceInitializationDefaulted('invalid-stored-value'),
      };
    } catch {
      return {
        value: fallback,
        outcome: preferenceInitializationDefaulted('storage-unavailable'),
      };
    }
  }

  private persist(key: string, on: boolean): void {
    void Preferences.set({ key, value: String(on) }).catch(() => undefined);
  }
}
