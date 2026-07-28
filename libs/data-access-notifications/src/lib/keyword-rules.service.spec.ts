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

/** A keyword rule as the server holds it. */
const keyword = (pattern: string, actions = NOTIFY_LOUD): Rule => ({
  rule_id: pattern,
  pattern,
  enabled: true,
  actions,
});

function makeClient(content: Rule[] = []) {
  const client = {
    pushRules: { global: { content } },
    addPushRule: vi.fn(() => Promise.resolve({})),
    deletePushRule: vi.fn(() => Promise.resolve({})),
    setPushRuleEnabled: vi.fn(() => Promise.resolve({})),
    setPushRuleActions: vi.fn(() => Promise.resolve({})),
    // Mirrors the real refresh: the service re-reads the ruleset after every write.
    getPushRules: vi.fn(() => Promise.resolve(client.pushRules)),
  };
  return client;
}

function setup(content?: Rule[], initialized = true) {
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
  describe('keywords', () => {
    it('lists the account’s keywords with their sound setting', () => {
      const { svc } = setup([
        keyword('oncall'),
        keyword('trinity', NOTIFY_SILENT),
      ]);

      expect(svc.keywords()).toEqual([
        { pattern: 'oncall', enabled: true, sound: true },
        { pattern: 'trinity', enabled: true, sound: false },
      ]);
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
      const { svc } = setup([
        { rule_id: '' },
        { rule_id: 'no-actions' },
        { rule_id: 'oncall', enabled: true, actions: NOTIFY_LOUD },
      ] as Rule[]);

      expect(svc.keywords().map((k) => k.pattern)).toEqual(['oncall']);
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

  describe('has', () => {
    it('matches case-insensitively, as the server’s own matching does', () => {
      const { svc } = setup([keyword('OnCall')]);

      expect(svc.has('oncall')).toBe(true);
      expect(svc.has('  ONCALL  ')).toBe(true);
      expect(svc.has('other')).toBe(false);
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

    it('refreshes the cached rules so the new keyword is readable at once', async () => {
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
    it('deletes the content rule by its keyword id', async () => {
      const { svc, client } = setup([keyword('oncall')]);

      await firstValueFrom(svc.remove('oncall'));

      expect(client.deletePushRule).toHaveBeenCalledWith(
        'global',
        'content',
        'oncall',
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
