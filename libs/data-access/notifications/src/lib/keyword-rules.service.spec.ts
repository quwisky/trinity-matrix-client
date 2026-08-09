import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { PushRuleKind } from 'matrix-js-sdk';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  KeywordRulesService,
  KeywordValidationError,
} from './keyword-rules.service';

interface Rule {
  rule_id: string;
  enabled?: boolean;
  actions?: unknown[];
  pattern?: string;
}

const NOTIFY_LOUD = [
  'notify',
  { set_tweak: 'sound', value: 'default' },
  { set_tweak: 'highlight' },
];
const NOTIFY_SILENT = ['notify', { set_tweak: 'highlight' }];

/** A keyword rule as the server holds it (Element keys these by the word itself). */
const keyword = (pattern: string, actions = NOTIFY_LOUD): Rule => ({
  rule_id: pattern,
  pattern,
  enabled: true,
  actions,
});

// `null` (not `undefined`) models a client whose push rules have not synced yet: a
// default parameter cannot tell "not passed" from "explicitly undefined".
function makeClient(content: Rule[] | null = []) {
  const client = {
    pushRules: content === null ? undefined : { global: { content } },
    // Parameter lists mirror the SDK's, so the `mock.calls[0][n]` assertions below are
    // typed against the real argument positions rather than an empty tuple.
    addPushRule: vi.fn(
      (
        _scope: string,
        _kind: PushRuleKind,
        _ruleId: string,
        _body: { actions?: unknown[]; pattern?: string },
      ) => Promise.resolve({}),
    ),
    deletePushRule: vi.fn(
      (_scope: string, _kind: PushRuleKind, _ruleId: string) =>
        Promise.resolve({}),
    ),
    setPushRuleEnabled: vi.fn(
      (
        _scope: string,
        _kind: PushRuleKind,
        _ruleId: string,
        _enabled: boolean,
      ) => Promise.resolve({}),
    ),
    setPushRuleActions: vi.fn(
      (
        _scope: string,
        _kind: PushRuleKind,
        _ruleId: string,
        _actions: unknown[],
      ) => Promise.resolve({}),
    ),
    // Mirrors the real SDK: getPushRules() assigns client.pushRules itself.
    getPushRules: vi.fn(() => Promise.resolve(client.pushRules)),
  };
  return client;
}

function setup(content: Rule[] | null = [], initialized = true) {
  const client = makeClient(content);
  TestBed.configureTestingModule({
    providers: [
      KeywordRulesService,
      MockProvider(MatrixClientService, {
        isInitialized: initialized,
        instance: client as never,
      }),
    ],
  });
  return { svc: TestBed.inject(KeywordRulesService), client };
}

describe('KeywordRulesService', () => {
  describe('hasLoaded', () => {
    // One TestBed per test: a second configureTestingModule in the same test does not
    // replace the first, so two setups would silently share one injector.
    it('is false until the account’s rules have synced', () => {
      // "You have no keywords" is a positive claim the UI must not make from an
      // empty list that simply has not arrived yet.
      expect(setup(null).svc.hasLoaded()).toBe(false);
    });

    it('is true once they have, so an empty list means the account holds none', () => {
      expect(setup([]).svc.hasLoaded()).toBe(true);
    });
  });

  describe('keywords', () => {
    it('lists the account’s keywords with their sound setting', () => {
      const { svc } = setup([
        keyword('oncall'),
        keyword('trinity', NOTIFY_SILENT),
      ]);

      expect(svc.keywords()).toEqual([
        {
          ruleId: 'oncall',
          pattern: 'oncall',
          enabled: true,
          sound: true,
          soundValue: 'default',
        },
        {
          ruleId: 'trinity',
          pattern: 'trinity',
          enabled: true,
          sound: false,
          soundValue: 'default',
        },
      ]);
    });

    it('keeps the rule id apart from the pattern when they differ', () => {
      // The spec permits any content-rule id; only Element happens to key by the word.
      // Addressing such a rule by its pattern would 404, so the id is carried through.
      const { svc } = setup([
        {
          rule_id: 'kw-7f3a',
          pattern: 'oncall',
          enabled: true,
          actions: NOTIFY_LOUD,
        },
      ]);

      expect(svc.keywords()[0]).toMatchObject({
        ruleId: 'kw-7f3a',
        pattern: 'oncall',
      });
    });

    it('hides the homeserver’s own content rules', () => {
      // `.m.rule.contains_user_name` lives in the very same bucket as the user's
      // keywords. Listing it would show someone their own username as a keyword —
      // and offer to delete a rule the server defines.
      const { svc } = setup([
        { rule_id: '.m.rule.contains_user_name', enabled: true, actions: [] },
        keyword('oncall'),
      ]);

      expect(svc.keywords().map((k) => k.pattern)).toEqual(['oncall']);
    });

    it('reports a keyword another client switched off', () => {
      const { svc } = setup([{ ...keyword('oncall'), enabled: false }]);

      expect(svc.keywords()[0]).toMatchObject({
        pattern: 'oncall',
        enabled: false,
      });
    });

    it('survives a malformed rule instead of throwing', () => {
      // This is user data round-tripped through a server and possibly another client,
      // and it is read inside a computed — a throw here blanks the settings page.
      // `null` in `actions` is the sharp one: `typeof null` is `'object'`.
      const { svc } = setup([
        { rule_id: '' },
        { rule_id: 'no-actions' },
        { rule_id: 'null-action', enabled: true, actions: [null, 'notify'] },
        { rule_id: 'oncall', enabled: true, actions: NOTIFY_LOUD },
      ] as Rule[]);

      expect(svc.keywords().map((k) => k.pattern)).toEqual([
        'null-action',
        'oncall',
      ]);
    });

    it('treats a rule that omits `enabled` as enabled', () => {
      // Reading it as disabled would render a live keyword as "Off" and, worse, make the
      // component's duplicate guard let a second rule be written for the same word.
      const { svc } = setup([
        { rule_id: 'oncall', actions: NOTIFY_LOUD, pattern: 'oncall' },
      ]);

      expect(svc.keywords()[0].enabled).toBe(true);
    });

    it('falls back to the rule id when a rule carries no pattern', () => {
      const { svc } = setup([
        { rule_id: 'oncall', enabled: true, actions: NOTIFY_LOUD },
      ]);

      expect(svc.keywords()[0].pattern).toBe('oncall');
    });

    it('is empty before sign-in', () => {
      expect(setup([], false).svc.keywords()).toEqual([]);
    });

    it('is empty — not a crash — when signed in before the rules have synced', () => {
      // The production ordering: the component's ngOnInit calls keywords() BEFORE
      // hasLoaded(), so a throw on the unsynced path blanks the settings section
      // instead of showing a list that fills in.
      expect(setup(null).svc.keywords()).toEqual([]);
    });
  });

  describe('find', () => {
    it('matches case-insensitively, as the server’s own matching does', () => {
      const { svc } = setup([keyword('OnCall')]);

      expect(svc.find('oncall')?.ruleId).toBe('OnCall');
      expect(svc.find('  ONCALL  ')?.ruleId).toBe('OnCall');
      expect(svc.find('other')).toBeUndefined();
    });

    it('matches a whole keyword, never a substring of one', () => {
      // A "more forgiving" match would make add('call') resolve to the OnCall rule and
      // overwrite it — typing one keyword silently destroys another.
      const { svc } = setup([keyword('OnCall')]);

      expect(svc.find('call')).toBeUndefined();
      expect(svc.find('OnCallRota')).toBeUndefined();
    });
  });

  describe('add', () => {
    it('writes a content rule whose id is the keyword itself', async () => {
      // Element keys keyword rules by the word, which is what lets a keyword list
      // round-trip between clients rather than each accumulating duplicates.
      const { svc, client } = setup();

      await firstValueFrom(svc.add('oncall'));

      expect(client.addPushRule).toHaveBeenCalledWith(
        'global',
        'content',
        'oncall',
        { actions: NOTIFY_LOUD, pattern: 'oncall' },
      );
    });

    it('writes silent actions when asked for no sound', async () => {
      const { svc, client } = setup();

      await firstValueFrom(svc.add('oncall', false));

      expect(client.addPushRule.mock.calls[0][3]).toEqual({
        actions: NOTIFY_SILENT,
        pattern: 'oncall',
      });
    });

    it('replaces a differently-cased keyword rather than duplicating it', async () => {
      // Content matching is case-insensitive server-side, so `OnCall` and `oncall`
      // fire on the same messages — two rules would mean two notifications for one word.
      const { svc, client } = setup([keyword('OnCall')]);

      await firstValueFrom(svc.add('oncall'));

      expect(client.addPushRule.mock.calls[0][2]).toBe('OnCall'); // the existing id
      expect(client.addPushRule.mock.calls[0][3]).toMatchObject({
        pattern: 'oncall',
      });
    });

    it('re-enables a keyword another client had switched off', async () => {
      const { svc, client } = setup([{ ...keyword('oncall'), enabled: false }]);

      await firstValueFrom(svc.add('oncall'));

      expect(client.setPushRuleEnabled).toHaveBeenCalledWith(
        'global',
        'content',
        'oncall',
        true,
      );
    });

    it('does not spend a round trip enabling a rule that is already on', async () => {
      // A rule the server just created is enabled; the extra PUT is what tips a burst
      // of adds into Synapse's push-rule rate limiter.
      const { svc, client } = setup();

      await firstValueFrom(svc.add('oncall'));

      expect(client.setPushRuleEnabled).not.toHaveBeenCalled();
    });

    it('trims the keyword before writing it', async () => {
      const { svc, client } = setup();

      await firstValueFrom(svc.add('  oncall  '));

      expect(client.addPushRule.mock.calls[0][2]).toBe('oncall');
    });

    it('rejects an empty or whitespace-only keyword without writing', async () => {
      const { svc, client } = setup();

      await expect(firstValueFrom(svc.add('   '))).rejects.toThrow(
        'Enter a word',
      );
      expect(client.addPushRule).not.toHaveBeenCalled();
    });

    it.each(['.net', 'a/b'])(
      'refuses %s, which cannot serve as the rule id',
      async (input) => {
        // A leading dot is the sharp one: the list filters server rules out, so `.net`
        // would be created, would notify, and would be invisible and unremovable.
        const { svc, client } = setup();

        await expect(firstValueFrom(svc.add(input))).rejects.toBeInstanceOf(
          KeywordValidationError,
        );
        expect(client.addPushRule).not.toHaveBeenCalled();
      },
    );

    it.each(['*', 'proj*', 'c?ris'])(
      'refuses %s, because a pattern is a glob and the field asks for a word',
      async (input) => {
        // `*` would become "notify on every message in every room", stored on the
        // account, so on every device and in every other client.
        const { svc, client } = setup();

        // The TYPE is the contract: the component surfaces a service message verbatim
        // only for a KeywordValidationError, so a plain Error here would leave the user
        // with "Could not add" and no idea why.
        await expect(firstValueFrom(svc.add(input))).rejects.toBeInstanceOf(
          KeywordValidationError,
        );
        await expect(firstValueFrom(svc.add(input))).rejects.toThrow(
          'cannot contain',
        );
        expect(client.addPushRule).not.toHaveBeenCalled();
      },
    );

    it('re-reads the rules so the new keyword is readable at once', async () => {
      // Without this the row the user just added is absent until the m.push_rules
      // account-data echo arrives on sync, so it looks like the add silently failed.
      const { svc, client } = setup();

      await firstValueFrom(svc.add('oncall'));

      expect(client.getPushRules).toHaveBeenCalled();
    });

    it('fails before sign-in without writing', async () => {
      const { svc, client } = setup([], false);

      await expect(firstValueFrom(svc.add('oncall'))).rejects.toThrow(
        'Not signed in.',
      );
      expect(client.addPushRule).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('deletes the content rule by its rule id, not its pattern', async () => {
      const { svc, client } = setup([
        {
          rule_id: 'kw-7f3a',
          pattern: 'oncall',
          enabled: true,
          actions: NOTIFY_LOUD,
        },
      ]);

      await firstValueFrom(svc.remove(svc.keywords()[0].ruleId));

      expect(client.deletePushRule).toHaveBeenCalledWith(
        'global',
        'content',
        'kw-7f3a',
      );
      expect(client.getPushRules).toHaveBeenCalled();
    });
  });

  describe('a rejected write', () => {
    it.each([
      ['add', (s: KeywordRulesService) => s.add('oncall')],
      ['remove', (s: KeywordRulesService) => s.remove('oncall')],
      ['setSound', (s: KeywordRulesService) => s.setSound('oncall', false)],
    ])('reaches the caller from %s', async (method, call) => {
      // A dropped `await` in write() — the classic — makes every failed write report
      // success, so the component never toasts, never restores the checkbox and never
      // re-reads. Nothing else on this branch pins it.
      const { svc, client } = setup([keyword('oncall')]);
      const boom = new Error('server said no');
      client.addPushRule.mockRejectedValue(boom);
      client.deletePushRule.mockRejectedValue(boom);
      client.setPushRuleActions.mockRejectedValue(boom);

      await expect(firstValueFrom(call(svc))).rejects.toBe(boom);
      expect(method).toBeTruthy(); // name is for the test label
    });
  });

  describe('a failed refresh after a successful write', () => {
    it.each([
      ['add', (s: KeywordRulesService) => s.add('oncall')],
      ['remove', (s: KeywordRulesService) => s.remove('oncall')],
      ['setSound', (s: KeywordRulesService) => s.setSound('oncall', false)],
    ])('is not reported as a failed write by %s', async (_method, call) => {
      // The write has already landed. Reporting the refresh's failure as the write's had
      // the UI insisting a removal failed while the rule was gone — and every retry then
      // 404ing, so the row could never be cleared. The list is merely stale until sync.
      const { svc, client } = setup([keyword('oncall')]);
      client.getPushRules.mockRejectedValue(new Error('offline'));

      await expect(firstValueFrom(call(svc))).resolves.toBeUndefined();
    });
  });

  describe('not signed in', () => {
    it.each([
      ['remove', (s: KeywordRulesService) => s.remove('oncall')],
      ['setSound', (s: KeywordRulesService) => s.setSound('oncall', false)],
    ])('%s refuses to write', async (_method, call) => {
      // Only add()'s copy of this guard was pinned; without the others the observable
      // dies on a TypeError against a null client instead of saying what is wrong.
      const { svc, client } = setup([], false);

      await expect(firstValueFrom(call(svc))).rejects.toThrow('Not signed in.');
      expect(client.deletePushRule).not.toHaveBeenCalled();
      expect(client.setPushRuleActions).not.toHaveBeenCalled();
    });
  });

  describe('setSound', () => {
    it('rewrites only the actions, leaving the keyword in place', async () => {
      const { svc, client } = setup([keyword('oncall')]);

      await firstValueFrom(svc.setSound('oncall', false));

      expect(client.setPushRuleActions).toHaveBeenCalledWith(
        'global',
        'content',
        'oncall',
        NOTIFY_SILENT,
      );
      expect(client.deletePushRule).not.toHaveBeenCalled();
      expect(client.addPushRule).not.toHaveBeenCalled();
    });

    it('carries forward a sound another client chose', async () => {
      // Toggling Sound off and back on must not quietly downgrade a custom tone to the
      // default — the user did not ask for that and nothing would tell them.
      const { svc, client } = setup([
        keyword('oncall', [
          'notify',
          { set_tweak: 'sound', value: 'ring' },
          { set_tweak: 'highlight' },
        ]),
      ]);

      await firstValueFrom(svc.setSound('oncall', true));

      expect(client.setPushRuleActions.mock.calls[0][3]).toContainEqual({
        set_tweak: 'sound',
        value: 'ring',
      });
    });

    it('turns a keyword’s sound ON, not only off', async () => {
      // Both existing cases pass `false`, so a hardcoded `actionsFor(false)` would
      // survive the whole suite — and the toggle would silently work one way only.
      const { svc, client } = setup([keyword('trinity', NOTIFY_SILENT)]);

      await firstValueFrom(svc.setSound('trinity', true));

      expect(client.setPushRuleActions).toHaveBeenCalledWith(
        'global',
        'content',
        'trinity',
        NOTIFY_LOUD,
      );
    });

    it('re-reads the rules, so the new setting is readable at once', async () => {
      // add and remove both go through write(); setSound bypassing it would leave the
      // component's post-write reload reading the stale value and flipping the checkbox
      // back on a write that actually succeeded.
      const { svc, client } = setup([keyword('oncall')]);

      await firstValueFrom(svc.setSound('oncall', false));

      expect(client.getPushRules).toHaveBeenCalled();
    });

    it('keeps the highlight tweak when the sound is turned off', async () => {
      // A keyword that notifies without marking where it matched is a notification
      // the user cannot act on.
      const { svc, client } = setup([keyword('oncall')]);

      await firstValueFrom(svc.setSound('oncall', false));

      expect(client.setPushRuleActions.mock.calls[0][3]).toContainEqual({
        set_tweak: 'highlight',
      });
    });
  });

  describe('per-account keywords', () => {
    /** Two signed-in accounts, each with its own keywords — the multi-account shape. */
    function setupOwned() {
      const activeClient = makeClient([keyword('active-word')]);
      const ownerClient = makeClient([keyword('owner-word')]);
      TestBed.configureTestingModule({
        providers: [
          KeywordRulesService,
          MockProvider(MatrixClientService, {
            isInitialized: true,
            instance: activeClient as never,
            clientFor: vi.fn((id: string) =>
              id === '@owner:hs' ? (ownerClient as never) : null,
            ),
          }),
        ],
      });
      return {
        svc: TestBed.inject(KeywordRulesService),
        activeClient,
        ownerClient,
      };
    }

    it('reads the named account’s keywords, not the active one’s', () => {
      const { svc } = setupOwned();

      expect(svc.keywords('@owner:hs').map((k) => k.pattern)).toEqual([
        'owner-word',
      ]);
      expect(svc.keywords().map((k) => k.pattern)).toEqual(['active-word']);
    });

    it('writes to the named account’s client', async () => {
      const { svc, activeClient, ownerClient } = setupOwned();

      await firstValueFrom(svc.add('oncall', true, '@owner:hs'));

      expect(ownerClient.addPushRule).toHaveBeenCalled();
      expect(activeClient.addPushRule).not.toHaveBeenCalled();
    });

    it('resolves an existing keyword against the SAME account it writes to', async () => {
      // `find` without the accountId would look the word up on the active account, miss,
      // and write a second rule to the owner — two rules matching one word.
      const { svc, ownerClient } = setupOwned();

      await firstValueFrom(svc.add('OWNER-WORD', true, '@owner:hs'));

      expect(ownerClient.addPushRule.mock.calls[0][2]).toBe('owner-word');
    });

    it('removes and re-sounds against the named account too', async () => {
      const { svc, activeClient, ownerClient } = setupOwned();

      await firstValueFrom(svc.remove('owner-word', '@owner:hs'));
      await firstValueFrom(svc.setSound('owner-word', false, '@owner:hs'));

      expect(ownerClient.deletePushRule).toHaveBeenCalled();
      expect(ownerClient.setPushRuleActions).toHaveBeenCalled();
      expect(activeClient.deletePushRule).not.toHaveBeenCalled();
      expect(activeClient.setPushRuleActions).not.toHaveBeenCalled();
    });

    it('reports load state per account', () => {
      const { svc } = setupOwned();

      expect(svc.hasLoaded('@owner:hs')).toBe(true);
      expect(svc.hasLoaded('@nobody:hs')).toBe(false); // no client for that account
    });
  });
});
