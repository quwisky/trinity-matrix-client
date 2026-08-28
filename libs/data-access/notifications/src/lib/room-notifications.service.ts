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
 * - `all` — notify for every message (the default; no room push rules).
 * - `mentions` — only mentions/keywords notify (a room-kind `dont_notify` rule; the
 *   override highlight rules still fire).
 * - `mute` — nothing notifies, mentions included (an override `dont_notify` rule on the
 *   room, which is evaluated ahead of the highlight rules).
 */
export type RoomNotifyMode = 'all' | 'mentions' | 'mute';

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
   * write fails, all targets are returned to their previous modes so the row cannot split
   * into contradictory per-account states.
   */
  setModeForAccounts(
    roomId: string,
    mode: RoomNotifyMode,
    accountIds?: readonly string[],
  ): Observable<void> {
    return defer(() => {
      const ids = accountIds?.length ? [...new Set(accountIds)] : [undefined];
      const clients = ids.map((accountId) => this.clientOwning(accountId));
      if (clients.some((client) => !client)) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(
        this.applyModes(
          clients.map((client) => client as MatrixClient),
          roomId,
          mode,
        ),
      );
    });
  }

  /** The client owning a room: the named account's, else the active one. */
  private clientOwning(accountId?: string): MatrixClient | null {
    if (accountId) {
      return this.matrix.clientFor(accountId);
    }
    return this.matrix.isInitialized ? this.matrix.instance : null;
  }

  private async applyModes(
    clients: readonly MatrixClient[],
    roomId: string,
    mode: RoomNotifyMode,
  ): Promise<void> {
    const targets = clients.map((client) => ({
      client,
      previous: this.modeForClient(client, roomId),
    }));
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
        await this.refreshRules(client).catch(() => undefined);
        await this.writeAndRefresh(client, roomId, previous);
        if (this.modeForClient(client, roomId) !== previous) {
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

  private async writeAndRefresh(
    client: MatrixClient,
    roomId: string,
    mode: RoomNotifyMode,
  ): Promise<void> {
    await this.writeMode(client, roomId, mode);
    await this.refreshRules(client);
  }

  private async writeMode(
    client: MatrixClient,
    roomId: string,
    mode: RoomNotifyMode,
  ): Promise<void> {
    switch (mode) {
      case 'all':
        await this.removeOverrideMute(client, roomId);
        // Remove the room-kind dont_notify rule (a no-op when none exists).
        await client.setRoomMutePushRule('global', roomId, false);
        break;
      case 'mentions':
        await this.removeOverrideMute(client, roomId);
        // Room-kind dont_notify — override highlight rules still notify.
        await client.setRoomMutePushRule('global', roomId, true);
        break;
      case 'mute':
        // Clear the room-kind rule, then add an override that beats the highlights.
        await client.setRoomMutePushRule('global', roomId, false);
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

  /** The enabled override `dont_notify` rule keyed by this room id, if any. */
  private overrideMuteRule(
    client: MatrixClient,
    roomId: string,
  ): IPushRule | undefined {
    return client.pushRules?.global?.override?.find(
      (rule) =>
        rule.rule_id === roomId &&
        rule.enabled &&
        rule.actions.includes(PushRuleActionName.DontNotify),
    );
  }

  private async addOverrideMute(
    client: MatrixClient,
    roomId: string,
  ): Promise<void> {
    if (this.overrideMuteRule(client, roomId)) {
      return;
    }
    await client.addPushRule('global', PushRuleKind.Override, roomId, {
      actions: [PushRuleActionName.DontNotify],
      conditions: [
        { kind: ConditionKind.EventMatch, key: 'room_id', pattern: roomId },
      ],
    });
  }

  private async removeOverrideMute(
    client: MatrixClient,
    roomId: string,
  ): Promise<void> {
    const exists = client.pushRules?.global?.override?.some(
      (rule) => rule.rule_id === roomId,
    );
    if (exists) {
      await client.deletePushRule('global', PushRuleKind.Override, roomId);
    }
  }
}
