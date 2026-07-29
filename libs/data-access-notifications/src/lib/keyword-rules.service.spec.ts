import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { KeywordRulesService } from './keyword-rules.service';

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
    addPushRule: vi.fn(() => Promise.resolve({})),
    deletePushRule: vi.fn(() => Promise.resolve({})),
    setPushRuleEnabled: vi.fn(() => Promise.resolve({})),
    setPushRuleActions: vi.fn(() => Promise.resolve({})),
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
        { ruleId: 'oncall', pattern: 'oncall', enabled: true, sound: true },
        { ruleId: 'trinity', pattern: 'trinity', enabled: true, sound: false },
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

    it('falls back to the rule id when a rule carries no pattern', () => {
      const { svc } = setup([
        { rule_id: 'oncall', enabled: true, actions: NOTIFY_LOUD },
      ]);

      expect(svc.keywords()[0].pattern).toBe('oncall');
    });

    it('is empty before sign-in', () => {
      expect(setup([], false).svc.keywords()).toEqual([]);
    });
  });

  describe('find', () => {
    it('matches case-insensitively, as the server’s own matching does', () => {
      const { svc } = setup([keyword('OnCall')]);

      expect(svc.find('oncall')?.ruleId).toBe('OnCall');
      expect(svc.find('  ONCALL  ')?.ruleId).toBe('OnCall');
      expect(svc.find('other')).toBeUndefined();
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

    it.each(['*', 'proj*', 'c?ris'])(
      'refuses %s, because a pattern is a glob and the field asks for a word',
      async (input) => {
        // `*` would become "notify on every message in every room", stored on the
        // account, so on every device and in every other client.
        const { svc, client } = setup();

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
});
