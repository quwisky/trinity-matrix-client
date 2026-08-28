import { Injectable, effect, inject, signal } from '@angular/core';
import {
  ClientEvent,
  ConditionKind,
  PushRuleActionName,
  PushRuleKind,
  type IPushRule,
  type MatrixClient,
} from 'matrix-js-sdk';
import { Observable, defer, from, throwError } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';

/**
 * Per-room notification level:
 * - `all` — notify for every message (the default; no enabled room mute rules).
 * - `mentions` — only mentions/keywords notify (a room-kind `dont_notify` rule; the
 *   override highlight rules still fire).
 * - `mute` — nothing notifies, mentions included (an override `dont_notify` rule on the
 *   room, which is evaluated ahead of the highlight rules).
 */
export type RoomNotifyMode = 'all' | 'mentions' | 'mute';
export type RoomNotifyDisplayMode = RoomNotifyMode | 'mixed';

interface RoomRuleSnapshot {
  room?: IPushRule;
  override?: IPushRule;
}

/** A failed room-notification write, including whether the prior server state was restored. */
export class RoomNotificationUpdateError extends Error {
  constructor(
    cause: unknown,
    readonly restored: boolean,
  ) {
    super(
      cause instanceof Error
        ? cause.message
        : 'Could not update notifications.',
      { cause },
    );
    this.name = 'RoomNotificationUpdateError';
  }
}

/**
 * Reads and writes a room's notification level via Matrix push rules. Kept separate
 * from the receipt/badge notification wiring: this owns the *preference*, not delivery.
 */
@Injectable({ providedIn: 'root' })
export class RoomNotificationsService {
  private readonly matrix = inject(MatrixClientService);
  private readonly _revision = signal(0);
  private readonly boundClients = new Set<MatrixClient>();
  /** Push-rule refreshes replace an account's whole cache, so writes share one queue. */
  private updateQueue: Promise<void> = Promise.resolve();
  private connected = false;

  private readonly onAccountData = (): void => this.bumpRevision();

  constructor() {
    /** Keep listeners aligned with the full live account set, including background accounts. */
    effect(() => {
      // Optional only for narrow unit-test doubles; production always exposes the signal.
      this.matrix.accountIds?.();
      if (this.connected) {
        this.rebindClients();
      }
    });
  }

  /** Start projecting remote push-rule changes into the zoneless room list. Idempotent. */
  connect(): void {
    this.connected = true;
    this.rebindClients();
    this.bumpRevision();
  }

  disconnect(): void {
    this.connected = false;
    for (const client of this.boundClients) {
      client.off(ClientEvent.AccountData, this.onAccountData);
    }
    this.boundClients.clear();
  }

  /** The room's current notification mode, derived from its push rules. Pass `accountId`
   * for a room owned by a non-active account (the mixed-account view) so the mode is read
   * from the account that actually holds the rules. */
  modeFor(roomId: string, accountId?: string): RoomNotifyMode {
    // A template call becomes a signal consumer. The app is zoneless, so the SDK's
    // AccountData callback must write a signal or a FluffyChat/other-device change would
    // remain invisible until the next unrelated click caused change detection.
    this._revision();
    const client = this.clientOwning(accountId);
    return client ? this.modeForClient(client, roomId) : 'all';
  }

  /** Aggregate the state represented by one merged room row. */
  modeForAccounts(
    roomId: string,
    accountIds?: readonly string[],
  ): RoomNotifyDisplayMode {
    const ids = accountIds?.length ? [...new Set(accountIds)] : [undefined];
    const modes = ids.map((accountId) => this.modeFor(roomId, accountId));
    const first = modes[0] ?? 'all';
    return modes.every((mode) => mode === first) ? first : 'mixed';
  }

  private modeForClient(client: MatrixClient, roomId: string): RoomNotifyMode {
    if (this.overrideMuteRule(client, roomId)) {
      return 'mute';
    }
    const roomRule = client.getRoomPushRule('global', roomId);
    if (
      roomRule?.enabled &&
      roomRule.actions.includes(PushRuleActionName.DontNotify)
    ) {
      return 'mentions';
    }
    return 'all';
  }

  /**
   * Apply a notification mode by (re)writing the room's push rules. Cold — fires on
   * subscribe — and refreshes the client's cached rules so {@link modeFor} reflects the
   * change immediately (before the `m.push_rules` account-data echo arrives on sync).
   */
  setMode(
    roomId: string,
    mode: RoomNotifyMode,
    accountId?: string,
  ): Observable<void> {
    return this.setModeForAccounts(
      roomId,
      mode,
      accountId ? [accountId] : undefined,
    );
  }

  /**
   * Apply one mode to every account represented by a merged room row. If any homeserver
   * write fails, every affected push rule is restored exactly so the row cannot split into
   * contradictory per-account states or lose a custom server-side detail.
   */
  setModeForAccounts(
    roomId: string,
    mode: RoomNotifyMode,
    accountIds?: readonly string[],
  ): Observable<void> {
    return defer(() => {
      const activeId = this.activeAccountId();
      const ids = accountIds?.length
        ? [...new Set(accountIds)]
        : activeId
          ? [activeId]
          : [];
      if (!ids.length) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(this.enqueueModeUpdate(ids, roomId, mode));
    });
  }

  /** The client owning a room: the named account's, else the active one. */
  private clientOwning(accountId?: string): MatrixClient | null {
    if (accountId) {
      return this.matrix.clientFor(accountId);
    }
    return this.matrix.isInitialized ? this.matrix.instance : null;
  }

  private activeAccountId(): string | null {
    if (!this.matrix.isInitialized) {
      return null;
    }
    return (
      this.matrix.activeUserId?.() ?? this.matrix.instance.getUserId() ?? null
    );
  }

  private async applyModes(
    clients: readonly MatrixClient[],
    roomId: string,
    mode: RoomNotifyMode,
  ): Promise<void> {
    // The SDK cache can lag a write made by another device. Read every homeserver before
    // taking the rollback snapshot, and do not start a cross-account transaction unless
    // every target has a trustworthy pre-write state.
    const initialRefreshes = await Promise.allSettled(
      clients.map((client) => this.refreshRules(client)),
    );
    const refreshFailure = initialRefreshes.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (refreshFailure) {
      throw new RoomNotificationUpdateError(refreshFailure.reason, true);
    }

    const targets = clients.map((client) => ({
      client,
      previous: this.snapshotRules(client, roomId),
    }));
    try {
      for (const { client } of targets) {
        this.assertRulesAreWritable(client, roomId);
      }
    } catch (error) {
      throw new RoomNotificationUpdateError(error, true);
    }
    const updates = await Promise.allSettled(
      targets.map(({ client }) => this.writeAndRefresh(client, roomId, mode)),
    );
    const failure = updates.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (!failure) {
      return;
    }

    // Each mode change can span two Matrix endpoints. Re-read the actual server state
    // before compensating, then restore every account—including peers that succeeded—so
    // a merged sidebar row remains one coherent preference.
    const restorations = await Promise.allSettled(
      targets.map(async ({ client, previous }) => {
        let currentStateKnown = true;
        await this.refreshRules(client).catch(() => {
          currentStateKnown = false;
        });
        await this.restoreRules(client, roomId, previous, !currentStateKnown);
        await this.refreshRules(client);
        if (!this.rulesMatchSnapshot(client, roomId, previous)) {
          throw new Error(
            'The previous notification setting was not restored.',
          );
        }
      }),
    );
    const restored = restorations.every(
      (result) => result.status === 'fulfilled',
    );
    if (!restored) {
      // Even when compensation fails, expose the homeserver's latest known state rather
      // than retaining a stale pre-write cache in the room menu.
      await Promise.allSettled(
        targets.map(({ client }) => this.refreshRules(client)),
      );
    }
    throw new RoomNotificationUpdateError(failure.reason, restored);
  }

  /**
   * Serialize every push-rule write. A refresh replaces the client's complete ruleset, so
   * room-scoped queues can still race each other's cache assignments. Account ids—not SDK
   * clients—are captured, allowing a queued update to use a replacement client after reauth.
   */
  private enqueueModeUpdate(
    accountIds: readonly string[],
    roomId: string,
    mode: RoomNotifyMode,
  ): Promise<void> {
    const current = this.updateQueue
      .catch(() => undefined)
      .then(() => {
        const clients = accountIds.map((accountId) =>
          this.matrix.clientFor(accountId),
        );
        if (clients.some((client) => !client)) {
          throw new Error('Not signed in.');
        }
        return this.applyModes(
          clients.map((client) => client as MatrixClient),
          roomId,
          mode,
        );
      });
    this.updateQueue = current;
    return current;
  }

  private async writeAndRefresh(
    client: MatrixClient,
    roomId: string,
    mode: RoomNotifyMode,
  ): Promise<void> {
    await this.writeMode(client, roomId, mode);
    await this.refreshRules(client);
    if (this.modeForClient(client, roomId) !== mode) {
      throw new Error('The homeserver did not apply the notification setting.');
    }
  }

  private async writeMode(
    client: MatrixClient,
    roomId: string,
    mode: RoomNotifyMode,
  ): Promise<void> {
    switch (mode) {
      case 'all':
        await this.disableOverrideMute(client, roomId);
        await this.disableRoomMute(client, roomId);
        break;
      case 'mentions':
        await this.disableOverrideMute(client, roomId);
        // Room-kind dont_notify — override highlight rules still notify.
        await this.addRoomMute(client, roomId);
        break;
      case 'mute':
        // Disable rather than delete so rollback cannot lose the rule's priority.
        await this.disableRoomMute(client, roomId);
        await this.addOverrideMute(client, roomId);
        break;
    }
  }

  private async refreshRules(client: MatrixClient): Promise<void> {
    // matrix-js-sdk also assigns this internally; retain the explicit assignment for
    // narrow test doubles and to keep the cache contract obvious at this boundary.
    client.pushRules = await client.getPushRules();
    this.bumpRevision();
  }

  private rebindClients(): void {
    // `all()` is always populated in production. Treat an undefined return as an empty
    // account set so narrow component-test doubles do not have to construct SDK clients
    // merely to exercise unrelated room-shell focus behaviour.
    const accounts = this.matrix.all?.() ?? [];
    const next = new Set(accounts.map((account) => account.client));
    for (const client of this.boundClients) {
      if (!next.has(client)) {
        client.off(ClientEvent.AccountData, this.onAccountData);
        this.boundClients.delete(client);
      }
    }
    for (const client of next) {
      if (!this.boundClients.has(client)) {
        client.on(ClientEvent.AccountData, this.onAccountData);
        this.boundClients.add(client);
      }
    }
  }

  private bumpRevision(): void {
    this._revision.update((revision) => revision + 1);
  }

  private snapshotRules(
    client: MatrixClient,
    roomId: string,
  ): RoomRuleSnapshot {
    return {
      room: this.cloneRule(
        this.ruleFor(client, PushRuleKind.RoomSpecific, roomId),
      ),
      override: this.cloneRule(
        this.ruleFor(client, PushRuleKind.Override, roomId),
      ),
    };
  }

  private cloneRule(rule: IPushRule | undefined): IPushRule | undefined {
    return rule ? structuredClone(rule) : undefined;
  }

  private ruleFor(
    client: MatrixClient,
    kind: PushRuleKind.RoomSpecific | PushRuleKind.Override,
    roomId: string,
  ): IPushRule | undefined {
    return client.pushRules?.global?.[kind]?.find(
      (rule) => rule.rule_id === roomId,
    );
  }

  private assertRulesAreWritable(client: MatrixClient, roomId: string): void {
    const roomRule = this.ruleFor(client, PushRuleKind.RoomSpecific, roomId);
    const overrideRule = this.ruleFor(client, PushRuleKind.Override, roomId);
    if (
      (roomRule && !this.isStandardRoomMute(roomRule)) ||
      (overrideRule && !this.isStandardOverrideMute(overrideRule, roomId))
    ) {
      throw new Error(
        'This room has a custom notification rule that Trinity will not overwrite.',
      );
    }
  }

  private isStandardRoomMute(rule: IPushRule): boolean {
    return (
      !rule.default &&
      rule.actions.length === 1 &&
      rule.actions[0] === PushRuleActionName.DontNotify &&
      !rule.conditions?.length &&
      rule.pattern === undefined
    );
  }

  private isStandardOverrideMute(rule: IPushRule, roomId: string): boolean {
    const [condition] = rule.conditions ?? [];
    return (
      !rule.default &&
      rule.actions.length === 1 &&
      rule.actions[0] === PushRuleActionName.DontNotify &&
      rule.conditions?.length === 1 &&
      condition?.kind === ConditionKind.EventMatch &&
      condition.key === 'room_id' &&
      condition.pattern === roomId &&
      rule.pattern === undefined
    );
  }

  private async restoreRules(
    client: MatrixClient,
    roomId: string,
    snapshot: RoomRuleSnapshot,
    force: boolean,
  ): Promise<void> {
    await this.restoreRule(
      client,
      PushRuleKind.RoomSpecific,
      roomId,
      snapshot.room,
      force,
    );
    await this.restoreRule(
      client,
      PushRuleKind.Override,
      roomId,
      snapshot.override,
      force,
    );
  }

  private async restoreRule(
    client: MatrixClient,
    kind: PushRuleKind.RoomSpecific | PushRuleKind.Override,
    roomId: string,
    snapshot: IPushRule | undefined,
    force: boolean,
  ): Promise<void> {
    const current = this.ruleFor(client, kind, roomId);
    if (!snapshot) {
      if (force || current) {
        await client.deletePushRule('global', kind, roomId).catch((error) => {
          if (!this.isMissingRuleError(error)) {
            throw error;
          }
        });
      }
      return;
    }

    const bodyReplaced =
      force || !current || !this.ruleBodiesEqual(current, snapshot);
    if (bodyReplaced) {
      await client.addPushRule('global', kind, roomId, {
        actions: structuredClone(snapshot.actions),
        ...(snapshot.conditions
          ? { conditions: structuredClone(snapshot.conditions) }
          : {}),
        ...(snapshot.pattern !== undefined
          ? { pattern: snapshot.pattern }
          : {}),
      });
    }
    if (force || bodyReplaced || current.enabled !== snapshot.enabled) {
      await client.setPushRuleEnabled('global', kind, roomId, snapshot.enabled);
    }
  }

  private isMissingRuleError(error: unknown): boolean {
    return (
      !!error &&
      typeof error === 'object' &&
      'errcode' in error &&
      error.errcode === 'M_NOT_FOUND'
    );
  }

  private rulesMatchSnapshot(
    client: MatrixClient,
    roomId: string,
    snapshot: RoomRuleSnapshot,
  ): boolean {
    return (
      this.rulesEqual(
        this.ruleFor(client, PushRuleKind.RoomSpecific, roomId),
        snapshot.room,
      ) &&
      this.rulesEqual(
        this.ruleFor(client, PushRuleKind.Override, roomId),
        snapshot.override,
      )
    );
  }

  private rulesEqual(
    actual: IPushRule | undefined,
    expected: IPushRule | undefined,
  ): boolean {
    if (!actual || !expected) {
      return actual === expected;
    }
    return (
      actual.rule_id === expected.rule_id &&
      actual.default === expected.default &&
      actual.enabled === expected.enabled &&
      this.ruleBodiesEqual(actual, expected)
    );
  }

  private ruleBodiesEqual(left: IPushRule, right: IPushRule): boolean {
    return (
      JSON.stringify(left.actions) === JSON.stringify(right.actions) &&
      JSON.stringify(left.conditions) === JSON.stringify(right.conditions) &&
      left.pattern === right.pattern
    );
  }

  /** The enabled override `dont_notify` rule keyed by this room id, if any. */
  private overrideMuteRule(
    client: MatrixClient,
    roomId: string,
  ): IPushRule | undefined {
    const rule = this.ruleFor(client, PushRuleKind.Override, roomId);
    return rule?.enabled && this.isStandardOverrideMute(rule, roomId)
      ? rule
      : undefined;
  }

  private async addOverrideMute(
    client: MatrixClient,
    roomId: string,
  ): Promise<void> {
    const existing = this.ruleFor(client, PushRuleKind.Override, roomId);
    if (existing?.enabled && this.isStandardOverrideMute(existing, roomId)) {
      return;
    }
    if (existing && this.isStandardOverrideMute(existing, roomId)) {
      await client.setPushRuleEnabled(
        'global',
        PushRuleKind.Override,
        roomId,
        true,
      );
      return;
    }
    await client.addPushRule('global', PushRuleKind.Override, roomId, {
      actions: [PushRuleActionName.DontNotify],
      conditions: [
        { kind: ConditionKind.EventMatch, key: 'room_id', pattern: roomId },
      ],
    });
  }

  private async disableOverrideMute(
    client: MatrixClient,
    roomId: string,
  ): Promise<void> {
    if (this.overrideMuteRule(client, roomId)) {
      await client.setPushRuleEnabled(
        'global',
        PushRuleKind.Override,
        roomId,
        false,
      );
    }
  }

  private async addRoomMute(
    client: MatrixClient,
    roomId: string,
  ): Promise<void> {
    const existing = this.ruleFor(client, PushRuleKind.RoomSpecific, roomId);
    if (existing?.enabled && this.isStandardRoomMute(existing)) {
      return;
    }
    if (existing && this.isStandardRoomMute(existing)) {
      await client.setPushRuleEnabled(
        'global',
        PushRuleKind.RoomSpecific,
        roomId,
        true,
      );
      return;
    }
    await client.addPushRule('global', PushRuleKind.RoomSpecific, roomId, {
      actions: [PushRuleActionName.DontNotify],
    });
  }

  private async disableRoomMute(
    client: MatrixClient,
    roomId: string,
  ): Promise<void> {
    const existing = this.ruleFor(client, PushRuleKind.RoomSpecific, roomId);
    if (existing?.enabled && this.isStandardRoomMute(existing)) {
      await client.setPushRuleEnabled(
        'global',
        PushRuleKind.RoomSpecific,
        roomId,
        false,
      );
    }
  }
}
