import type { Observable } from 'rxjs';
import type { EngineResult } from '@trinity/util/matrix';

export type PushRuleKind =
  'override' | 'content' | 'room' | 'sender' | 'underride';

/** A server-defined rule (id starting with `.`) as the synced ruleset holds it. */
export interface DefaultPushRule {
  readonly ruleId: string;
  readonly kind: PushRuleKind;
  readonly enabled: boolean;
}

/** A word the account notifies on, keyed by the word itself; it carries no sound of its own. */
export interface KeywordRule {
  readonly pattern: string;
  /** True when any rule for the word is enabled. */
  readonly enabled: boolean;
}

/**
 * A room's notification level: `all` (the account default, or a notifying room rule),
 * `mentions` (a no-notify room rule; mentions and keywords still notify), `mute` (a no-notify
 * override for the room, ahead of the mention rules).
 */
export type RoomNotifyMode = 'all' | 'mentions' | 'mute';

/** A Trinity account-data preference; see {@link NotificationSettings}. */
export type NotificationPreference = 'sound' | 'reactionNotifications';

/** One account's notification preferences. */
export interface NotificationSettings {
  /** False until the push rules have synced; an empty keyword list then means "not yet". */
  readonly loaded: boolean;
  /** Every server-defined rule, overrides first and underrides last. */
  readonly defaultRules: readonly DefaultPushRule[];
  /** One entry per word, in server order; malformed rules skipped. */
  readonly keywords: readonly KeywordRule[];
  /**
   * Rooms whose rules give a mode other than `all`: `mute` for an enabled override without
   * `notify` matching the room, else `mentions` for an enabled room rule without `notify`.
   * Rust `get_user_defined_room_notification_mode`, except that a disabled room rule counts
   * for nothing (Trinity used to switch its rules off rather than delete them).
   */
  readonly roomModes: Readonly<Record<string, Exclude<RoomNotifyMode, 'all'>>>;
  /** Whether notifications may make a sound; on unless the account says otherwise. */
  readonly sound: boolean;
  /** Whether reactions to the account's messages notify; off unless the account opts in. */
  readonly reactionNotifications: boolean;
}

/**
 * One account's push-rule settings. `settings` emits its snapshot on subscribe (the js-sdk
 * adapter synchronously), then a whole snapshot per change; an account without a live client
 * emits an unloaded, empty snapshot with the default preferences. The preferences are Trinity
 * account data; their retired `eu.qwky.trinity.*` names are read while only they exist, and
 * copied to the current names while `settings` is subscribed. A replaced client is not followed: subscribe again for
 * the new session generation. Commands emit once and complete, after `settings` already
 * holds their effect; they fail `account-not-live` without a live client, else
 * `request-failed`.
 */
export interface NotificationEngine {
  /** Rust: `Client::notification_settings()` + `subscribe_to_changes()`, read through `Ruleset`. */
  settings(accountId: string): Observable<NotificationSettings>;

  /** Rust: `NotificationSettings::set_push_rule_enabled(kind, rule_id, enabled)` per rule. */
  setPushRulesEnabled(
    accountId: string,
    rules: readonly { readonly ruleId: string; readonly kind: PushRuleKind }[],
    enabled: boolean,
  ): Observable<EngineResult<null>>;

  /**
   * Adds a rule keyed by `pattern`, or rewrites and enables one of its rules when none is
   * enabled. The rule is written with exactly the actions `notify`, `sound: default` and
   * `highlight` (the highlight colours the room in the list). Rust
   * `NotificationSettings::add_keyword` writes `[Notify, Sound(default)]` without highlight
   * (matrix-rust-sdk `notification_settings/command.rs`), so a Rust engine writes the
   * keyword as a custom content rule instead.
   */
  setKeyword(
    accountId: string,
    pattern: string,
  ): Observable<EngineResult<null>>;

  /** Deletes every rule for `pattern`. Rust: `NotificationSettings::remove_keyword`. */
  removeKeyword(
    accountId: string,
    pattern: string,
  ): Observable<EngineResult<null>>;

  /**
   * Rust `NotificationSettings::set_room_notification_mode`: re-reads the server rules, then
   * writes the mode's rule (`all`: a room rule with `notify` and the default sound; `mentions`:
   * a room rule without actions; `mute`: an override for the room without actions) and deletes
   * the room's other rules (override, room and underride rules keyed by or matching it). A
   * no-op when the room's user-defined mode already is `mode`. Also enables a disabled rule it
   * overwrites, which Rust leaves off (a PUT keeps its enabled flag). One account's writes run
   * one after another, each reading the rules its predecessor left.
   */
  setRoomMode(
    accountId: string,
    roomId: string,
    mode: RoomNotifyMode,
  ): Observable<EngineResult<null>>;

  /**
   * The room's mode after re-reading the server rules, which `settings` then holds.
   * Rust: `get_user_defined_room_notification_mode` (None → `all`) over a fresh ruleset.
   */
  readRoomMode(
    accountId: string,
    roomId: string,
  ): Observable<EngineResult<RoomNotifyMode>>;

  /** Writes the preference under its current name. Rust: `Account::set_account_data_raw`. */
  setPreference(
    accountId: string,
    preference: NotificationPreference,
    on: boolean,
  ): Observable<EngineResult<null>>;
}
