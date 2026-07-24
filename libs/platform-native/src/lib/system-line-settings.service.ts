import { Injectable, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';

const MEMBERSHIP_KEY = 'trinity.timeline.show-membership';
const PROFILE_KEY = 'trinity.timeline.show-profile';
const ROOM_CHANGES_KEY = 'trinity.timeline.show-room-changes';

/**
 * Which categories of *system line* the timeline renders between messages — "Bob joined the
 * room", "Bob changed their profile picture", "Mod changed the room topic".
 *
 * In busy or bridged rooms the membership/profile churn drowns out the conversation, so each
 * category can be turned off independently. All three default to shown, so an existing
 * install sees no change until the user opts out.
 *
 * Device-scoped, like the other UI preferences ({@link PrivacySettingsService}, the theme):
 * non-secret, so they live in Capacitor `Preferences` rather than secure storage. Hiding is
 * purely visual — unread counts come from the server's notification counts and are untouched.
 */
@Injectable({ providedIn: 'root' })
export class SystemLineSettingsService {
  private readonly _showMembership = signal(true);
  private readonly _showProfile = signal(true);
  private readonly _showRoomChanges = signal(true);

  /** Joins, leaves, invites, knocks, kicks/bans/unbans. */
  readonly showMembership = this._showMembership.asReadonly();

  /** Display-name and profile-picture changes by existing members. */
  readonly showProfile = this._showProfile.asReadonly();

  /** Room name, topic, avatar, alias, join rules, history, guest access, encryption. */
  readonly showRoomChanges = this._showRoomChanges.asReadonly();

  /** Read the saved preferences and apply them. Call once at app startup. */
  async init(): Promise<void> {
    this._showMembership.set(await this.read(MEMBERSHIP_KEY, true));
    this._showProfile.set(await this.read(PROFILE_KEY, true));
    this._showRoomChanges.set(await this.read(ROOM_CHANGES_KEY, true));
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

  private async read(key: string, fallback: boolean): Promise<boolean> {
    try {
      const { value } = await Preferences.get({ key });
      return value === null ? fallback : value === 'true';
    } catch {
      return fallback; // storage unavailable → keep the default
    }
  }

  private persist(key: string, on: boolean): void {
    void Preferences.set({ key, value: String(on) }).catch(() => undefined);
  }
}
