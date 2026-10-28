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

/** One account's notification preferences. */
export interface NotificationSettings {
  /** False until the push rules have synced; an empty keyword list then means "not yet". */
  readonly loaded: boolean;
  /** Every server-defined rule, overrides first and underrides last. */
  readonly defaultRules: readonly DefaultPushRule[];
  /** One entry per word, in server order; malformed rules skipped. */
  readonly keywords: readonly KeywordRule[];
}

/**
 * One account's push-rule settings. `settings` emits its snapshot on subscribe (the js-sdk
 * adapter synchronously), then a whole snapshot per change; an account without a live client
 * emits an unloaded, empty snapshot. A replaced client is not followed: subscribe again for
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
}
