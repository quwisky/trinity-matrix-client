import { TestBed } from '@angular/core/testing';
import { ClientEvent, MatrixError } from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import type { NotificationSettings } from '../notification-engine';
import { JsSdkNotificationEngine } from './js-sdk-notification-engine';

const ALICE = '@alice:hs';

interface Rules {
  global: Record<string, unknown[] | undefined>;
}

function fakeClient(initial?: Rules) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const client = {
    pushRules: initial,
    server: initial,
    emit(event: string, ...args: unknown[]) {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },
    on(event: string, fn: (...args: unknown[]) => void) {
      (listeners.get(event) ?? listeners.set(event, new Set()).get(event))?.add(
        fn,
      );
    },
    off(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn);
    },
    /** Assigns the server's rules, as the SDK's getPushRules does. */
    getPushRules: vi.fn(async () => {
      client.pushRules = client.server;
      return client.pushRules;
    }),
    addPushRule: vi.fn().mockResolvedValue({}),
    deletePushRule: vi.fn().mockResolvedValue({}),
    setPushRuleEnabled: vi.fn().mockResolvedValue({}),
  };
  return client;
}

const KEYWORD_ACTIONS = [
  'notify',
  { set_tweak: 'sound', value: 'default' },
  { set_tweak: 'highlight' },
];

const keyword = (ruleId: unknown, pattern: unknown, enabled = true) => ({
  rule_id: ruleId,
  pattern,
  enabled,
  default: false,
  actions: ['notify'],
});

describe('JsSdkNotificationEngine', () => {
  let client: ReturnType<typeof fakeClient>;
  let engine: JsSdkNotificationEngine;

  function setup(initial?: Rules): void {
    client = fakeClient(initial);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: JS_SDK_CLIENTS,
          useValue: {
            clientFor: (id: string) => (id === ALICE ? client : null),
          },
        },
      ],
    });
    engine = TestBed.inject(JsSdkNotificationEngine);
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('reads the cached rules synchronously, skipping malformed ones and folding keywords by word', () => {
    setup({
      global: {
        override: [
          { rule_id: '.m.rule.master', enabled: false, default: true },
          null,
          { rule_id: 'custom-override', enabled: true },
        ],
        content: [
          { rule_id: '.m.rule.contains_user_name', enabled: true },
          keyword('cat', 'cat', false),
          keyword('Cat-2', 'cat', true),
          keyword('dog', undefined),
          keyword(7, 'bird'),
          { rule_id: 'no-actions', pattern: 'x' },
        ],
        underride: [{ rule_id: '.m.rule.message', enabled: true }],
      },
    });
    const seen: NotificationSettings[] = [];

    engine.settings(ALICE).subscribe((settings) => seen.push(settings));

    expect(seen).toEqual([
      {
        loaded: true,
        defaultRules: [
          { ruleId: '.m.rule.master', kind: 'override', enabled: false },
          {
            ruleId: '.m.rule.contains_user_name',
            kind: 'content',
            enabled: true,
          },
          { ruleId: '.m.rule.message', kind: 'underride', enabled: true },
        ],
        keywords: [
          { pattern: 'cat', enabled: true },
          { pattern: 'dog', enabled: true },
        ],
      },
    ]);
  });

  it('emits unloaded before the rules sync, then the rules once a sync brings them', async () => {
    setup();
    const seen: NotificationSettings[] = [];
    engine.settings(ALICE).subscribe((settings) => seen.push(settings));
    expect(seen).toEqual([{ loaded: false, defaultRules: [], keywords: [] }]);

    client.pushRules = { global: { content: [keyword('cat', 'cat')] } };
    client.emit(ClientEvent.Sync, 'PREPARED');
    client.emit(ClientEvent.Sync, 'SYNCING');
    await Promise.resolve();

    expect(seen).toHaveLength(2);
    expect(seen[1].keywords).toEqual([{ pattern: 'cat', enabled: true }]);

    // Once loaded, changes arrive as m.push_rules account data, not per sync.
    client.pushRules = { global: { content: [] } };
    client.emit(ClientEvent.Sync, 'SYNCING');
    await Promise.resolve();
    expect(seen).toHaveLength(2);
  });

  it('re-emits on an m.push_rules change only', async () => {
    setup({ global: { content: [] } });
    const seen: NotificationSettings[] = [];
    engine.settings(ALICE).subscribe((settings) => seen.push(settings));

    client.pushRules = { global: { content: [keyword('cat', 'cat')] } };
    client.emit(ClientEvent.AccountData, { getType: () => 'm.direct' });
    await Promise.resolve();
    expect(seen).toHaveLength(1);

    client.emit(ClientEvent.AccountData, { getType: () => 'm.push_rules' });
    await Promise.resolve();
    expect(seen).toHaveLength(2);
  });

  it('adds a rule keyed by the word, then replies after the refreshed snapshot', async () => {
    setup({ global: { content: [] } });
    const seen: NotificationSettings[] = [];
    engine.settings(ALICE).subscribe((settings) => seen.push(settings));
    client.server = { global: { content: [keyword('cat', 'cat')] } };

    const result = await firstValueFrom(engine.setKeyword(ALICE, 'cat'));

    expect(result).toEqual({ ok: true, value: null });
    expect(client.addPushRule).toHaveBeenCalledWith(
      'global',
      'content',
      'cat',
      {
        pattern: 'cat',
        actions: KEYWORD_ACTIONS,
      },
    );
    expect(seen.at(-1)?.keywords).toEqual([{ pattern: 'cat', enabled: true }]);
  });

  it('rewrites and enables the first rule of a disabled keyword, and leaves an enabled one alone', async () => {
    setup({
      global: {
        content: [keyword('Cat-1', 'cat', false), keyword('cat', 'cat', false)],
      },
    });

    await firstValueFrom(engine.setKeyword(ALICE, 'cat'));
    expect(client.addPushRule).toHaveBeenCalledExactlyOnceWith(
      'global',
      'content',
      'Cat-1',
      { pattern: 'cat', actions: KEYWORD_ACTIONS },
    );
    expect(client.setPushRuleEnabled).toHaveBeenCalledExactlyOnceWith(
      'global',
      'content',
      'Cat-1',
      true,
    );

    client.pushRules = { global: { content: [keyword('cat', 'cat', true)] } };
    client.addPushRule.mockClear();
    client.setPushRuleEnabled.mockClear();
    await firstValueFrom(engine.setKeyword(ALICE, 'cat'));
    expect(client.addPushRule).not.toHaveBeenCalled();
    expect(client.setPushRuleEnabled).not.toHaveBeenCalled();
  });

  it('enables a disabled rule it overwrites because its id is the word', async () => {
    // Legacy re-point data: id `OnCall`, pattern `oncall`. The PUT rewrites the pattern but
    // the server keeps the stored enabled flag.
    setup({ global: { content: [keyword('OnCall', 'oncall', false)] } });

    await firstValueFrom(engine.setKeyword(ALICE, 'OnCall'));

    expect(client.addPushRule).toHaveBeenCalledWith(
      'global',
      'content',
      'OnCall',
      { pattern: 'OnCall', actions: KEYWORD_ACTIONS },
    );
    expect(client.setPushRuleEnabled).toHaveBeenCalledWith(
      'global',
      'content',
      'OnCall',
      true,
    );
  });

  it('deletes every rule for a word, also one keyed by another id', async () => {
    setup({
      global: {
        content: [
          keyword('cat', 'cat'),
          keyword('dog', 'dog'),
          keyword('Cat-2', 'cat'),
        ],
      },
    });

    await firstValueFrom(engine.removeKeyword(ALICE, 'cat'));

    expect(client.deletePushRule.mock.calls).toEqual([
      ['global', 'content', 'cat'],
      ['global', 'content', 'Cat-2'],
    ]);
  });

  it('enables each named rule', async () => {
    setup({ global: {} });

    await firstValueFrom(
      engine.setPushRulesEnabled(
        ALICE,
        [
          { ruleId: '.m.rule.master', kind: 'override' },
          { ruleId: '.m.rule.message', kind: 'underride' },
        ],
        true,
      ),
    );

    expect(client.setPushRuleEnabled.mock.calls).toEqual([
      ['global', 'override', '.m.rule.master', true],
      ['global', 'underride', '.m.rule.message', true],
    ]);
  });

  it('reports a landed write as done when the refresh fails', async () => {
    setup({ global: {} });
    client.getPushRules.mockRejectedValueOnce(new Error('offline'));

    expect(await firstValueFrom(engine.setKeyword(ALICE, 'cat'))).toEqual({
      ok: true,
      value: null,
    });
  });

  it('re-reads and publishes the rules after a partly failed write', async () => {
    setup({
      global: { content: [keyword('cat', 'cat'), keyword('Cat-2', 'cat')] },
    });
    const seen: NotificationSettings[] = [];
    const sub = engine.settings(ALICE).subscribe((s) => seen.push(s));
    client.server = { global: { content: [keyword('Cat-2', 'cat')] } };
    client.deletePushRule
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('offline'));

    const result = await firstValueFrom(engine.removeKeyword(ALICE, 'cat'));
    sub.unsubscribe();

    expect(result.ok).toBe(false);
    expect(client.getPushRules).toHaveBeenCalled();
    expect(seen.at(-1)?.keywords).toEqual([{ pattern: 'cat', enabled: true }]);
    expect(client.pushRules).toBe(client.server);
  });

  it('reports a refused write as request-failed', async () => {
    setup({ global: {} });
    client.addPushRule.mockRejectedValueOnce(
      new MatrixError({ errcode: 'M_FORBIDDEN', error: 'no' }, 403),
    );

    const result = await firstValueFrom(engine.setKeyword(ALICE, 'cat'));

    expect(result.ok || result.failure).toMatchObject({
      code: 'request-failed',
      kind: 'permission',
    });
  });
});
