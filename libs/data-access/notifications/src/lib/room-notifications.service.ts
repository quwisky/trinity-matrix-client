import { Injectable, inject } from '@angular/core';
import {
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

/**
 * Reads and writes a room's notification level via Matrix push rules. Kept separate
 * from the receipt/badge notification wiring: this owns the *preference*, not delivery.
 */
@Injectable({ providedIn: 'root' })
export class RoomNotificationsService {
  private readonly matrix = inject(MatrixClientService);

  /** The room's current notification mode, derived from its push rules. Pass `accountId`
   * for a room owned by a non-active account (the mixed-account view) so the mode is read
   * from the account that actually holds the rules. */
  modeFor(roomId: string, accountId?: string): RoomNotifyMode {
    const client = this.clientOwning(accountId);
    if (!client) {
      return 'all';
    }
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
    return defer(() => {
      const client = this.clientOwning(accountId);
      if (!client) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(this.applyMode(client, roomId, mode));
    });
  }

  /** The client owning a room: the named account's, else the active one. */
  private clientOwning(accountId?: string): MatrixClient | null {
    if (accountId) {
      return this.matrix.clientFor(accountId);
    }
    return this.matrix.isInitialized ? this.matrix.instance : null;
  }

  private async applyMode(
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
    // Keep the cached rules current so a subsequent modeFor() is accurate at once.
    client.pushRules = await client.getPushRules();
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
