import { Injectable, inject } from '@angular/core';
import {
  ClientEvent,
  type IPushRule,
  type MatrixClient,
  type MatrixEvent,
  PushRuleActionName,
  type PushRuleAction,
  PushRuleKind as SdkPushRuleKind,
  TweakName,
} from 'matrix-js-sdk';
import {
  NEVER,
  Observable,
  Subject,
  catchError,
  concat,
  defer,
  distinctUntilChanged,
  from,
  map,
  of,
} from 'rxjs';
import { JS_SDK_CLIENTS, coalesce } from '@trinity/data-access/matrix-client';
import {
  type EngineFailure,
  type EngineResult,
  describeMatrixRequestFailure,
  engineFail,
  engineOk,
  plainEqual,
} from '@trinity/util/matrix';
import type {
  DefaultPushRule,
  KeywordRule,
  NotificationEngine,
  NotificationSettings,
  PushRuleKind,
} from '../notification-engine';

const KINDS: readonly PushRuleKind[] = [
  'override',
  'content',
  'room',
  'sender',
  'underride',
];

const UNLOADED: NotificationSettings = {
  loaded: false,
  defaultRules: [],
  keywords: [],
};

const NOT_LIVE: EngineFailure = {
  kind: 'unexpected',
  code: 'account-not-live',
  diagnostic: { kind: 'unexpected' },
};

/**
 * Notify with the default sound, and highlight: the highlight colours the room in the list.
 * The actions are regenerated, never merged: a carried `dont_notify` would silence the word.
 */
const KEYWORD_ACTIONS: PushRuleAction[] = [
  PushRuleActionName.Notify,
  { set_tweak: TweakName.Sound, value: 'default' },
  { set_tweak: TweakName.Highlight },
];

/** `request-failed`, with a refresh failure marked as the session's. */
function requestFailed(error: unknown): EngineFailure {
  const { kind, diagnostic } = describeMatrixRequestFailure(error);
  return {
    kind,
    code: 'request-failed',
    diagnostic,
    ...(diagnostic.errorName === 'TokenRefreshError'
      ? { params: { cause: 'session-refresh' as const } }
      : {}),
  };
}

function rulesOf(client: MatrixClient, kind: PushRuleKind): readonly unknown[] {
  const list: unknown = (
    client.pushRules?.global as Record<string, unknown> | undefined
  )?.[kind];
  return Array.isArray(list) ? list : [];
}

/** A server-defined rule: the spec reserves a leading dot for them. */
function isServerRule(ruleId: string): boolean {
  return ruleId.startsWith('.');
}

function ruleIdOf(rule: unknown): string {
  const id: unknown = (rule as { rule_id?: unknown } | null)?.rule_id;
  return typeof id === 'string' ? id : '';
}

/**
 * The account's keyword rules, with the word each matches. Malformed rules (server or
 * another client's data) are skipped, so a bad rule never blanks the settings.
 */
function keywordRules(client: MatrixClient): {
  readonly ruleId: string;
  readonly pattern: string;
  readonly enabled: boolean;
}[] {
  return rulesOf(client, 'content').flatMap((value) => {
    const ruleId = ruleIdOf(value);
    const rule = value as Partial<IPushRule>;
    if (!ruleId || isServerRule(ruleId) || !Array.isArray(rule.actions)) {
      return [];
    }
    return [
      {
        ruleId,
        pattern: typeof rule.pattern === 'string' ? rule.pattern : ruleId,
        enabled: rule.enabled !== false,
      },
    ];
  });
}

function settingsOf(client: MatrixClient | null): NotificationSettings {
  if (!client?.pushRules?.global) return UNLOADED;
  const defaultRules = KINDS.flatMap((kind) =>
    rulesOf(client, kind).flatMap((rule): DefaultPushRule[] => {
      const ruleId = ruleIdOf(rule);
      return isServerRule(ruleId)
        ? [{ ruleId, kind, enabled: (rule as IPushRule).enabled === true }]
        : [];
    }),
  );
  const words = new Map<string, boolean>();
  for (const { pattern, enabled } of keywordRules(client)) {
    words.set(pattern, !!words.get(pattern) || enabled);
  }
  return {
    loaded: true,
    defaultRules,
    keywords: [...words].map(([pattern, enabled]): KeywordRule => ({
      pattern,
      enabled,
    })),
  };
}

/** {@link NotificationEngine} over the live matrix-js-sdk clients of {@link JS_SDK_CLIENTS}. */
@Injectable({ providedIn: 'root' })
export class JsSdkNotificationEngine implements NotificationEngine {
  private readonly clients = inject(JS_SDK_CLIENTS);
  /** A client whose rules a command has just re-read. */
  private readonly refreshed = new Subject<MatrixClient>();

  settings(accountId: string): Observable<NotificationSettings> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return concat(of(UNLOADED), NEVER);
      return new Observable<NotificationSettings>((subscriber) => {
        const onSync = (): void => queued.schedule();
        const publish = (): void => {
          if (this.clients.clientFor(accountId) !== client) return;
          const settings = settingsOf(client);
          // Later changes arrive as m.push_rules account data.
          if (settings.loaded) client.off(ClientEvent.Sync, onSync);
          subscriber.next(settings);
        };
        const queued = coalesce(publish);
        const onAccountData = (event: MatrixEvent): void => {
          if (event.getType() === 'm.push_rules') queued.schedule();
        };
        // The rules fetched before the first sync arrive without an account-data event.
        client.on(ClientEvent.Sync, onSync);
        client.on(ClientEvent.AccountData, onAccountData);
        const commands = this.refreshed.subscribe((target) => {
          if (target === client) publish();
        });
        publish();
        return () => {
          queued.cancel();
          commands.unsubscribe();
          client.off(ClientEvent.Sync, onSync);
          client.off(ClientEvent.AccountData, onAccountData);
        };
      }).pipe(distinctUntilChanged<NotificationSettings>(plainEqual));
    });
  }

  setPushRulesEnabled(
    accountId: string,
    rules: readonly { readonly ruleId: string; readonly kind: PushRuleKind }[],
    enabled: boolean,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, (client) =>
      Promise.all(
        rules.map(({ ruleId, kind }) =>
          client.setPushRuleEnabled(
            'global',
            kind as SdkPushRuleKind,
            ruleId,
            enabled,
          ),
        ),
      ),
    );
  }

  setKeyword(
    accountId: string,
    pattern: string,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, async (client) => {
      const rules = keywordRules(client);
      const existing = rules.filter((rule) => rule.pattern === pattern);
      if (existing.length === 0) {
        // The id may already hold a rule for another spelling; the PUT keeps its enabled flag.
        const taken = rules.find((rule) => rule.ruleId === pattern);
        await client.addPushRule(
          'global',
          SdkPushRuleKind.ContentSpecific,
          pattern,
          { pattern, actions: KEYWORD_ACTIONS },
        );
        if (taken && !taken.enabled) {
          await client.setPushRuleEnabled(
            'global',
            SdkPushRuleKind.ContentSpecific,
            pattern,
            true,
          );
        }
      } else if (!existing.some((rule) => rule.enabled)) {
        // Rewritten too: another client's rule may carry other actions.
        await client.addPushRule(
          'global',
          SdkPushRuleKind.ContentSpecific,
          existing[0].ruleId,
          { pattern, actions: KEYWORD_ACTIONS },
        );
        await client.setPushRuleEnabled(
          'global',
          SdkPushRuleKind.ContentSpecific,
          existing[0].ruleId,
          true,
        );
      }
    });
  }

  removeKeyword(
    accountId: string,
    pattern: string,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, (client) =>
      Promise.all(
        keywordRules(client)
          .filter((rule) => rule.pattern === pattern)
          .map((rule) =>
            client.deletePushRule(
              'global',
              SdkPushRuleKind.ContentSpecific,
              rule.ruleId,
            ),
          ),
      ),
    );
  }

  /**
   * Runs `write`, re-reads the rules and publishes them to `settings` before replying, so the
   * reply never precedes its effect. A failed re-read leaves the rules to the sync echo: the
   * write has landed, and reporting it as failed would invite a retry that 404s.
   */
  private command(
    accountId: string,
    write: (client: MatrixClient) => Promise<unknown>,
  ): Observable<EngineResult<null>> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return of(engineFail(NOT_LIVE));
      return from(
        (async () => {
          try {
            await write(client);
          } finally {
            // Also after a partial failure: some of the writes may have landed.
            await client.getPushRules().catch(() => undefined);
            this.refreshed.next(client);
          }
          return null;
        })(),
      ).pipe(
        map((value) => engineOk(value)),
        catchError((error: unknown) => of(engineFail(requestFailed(error)))),
      );
    });
  }
}
