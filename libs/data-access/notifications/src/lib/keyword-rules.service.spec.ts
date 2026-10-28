import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { EngineRequestError, engineFail, engineOk } from '@trinity/util/matrix';
import { setupLiveNotificationSettings } from '../contract/live-notification-settings';
import {
  KeywordRulesService,
  KeywordValidationError,
} from './keyword-rules.service';

const KEYWORD_ACTIONS = [
  'notify',
  { set_tweak: 'sound', value: 'default' },
  { set_tweak: 'highlight' },
];

const REFUSED = engineFail({
  kind: 'http',
  code: 'request-failed',
  diagnostic: { kind: 'http', httpStatus: 500 },
});

/** An account that is live but whose settings the fake never loads. */
const BOB = '@bob:fake';

function setup(options?: { active?: string | null; live?: string[] }) {
  const { engine, alice } = setupLiveNotificationSettings(options);
  return {
    svc: TestBed.inject(KeywordRulesService),
    engine,
    alice,
    setKeyword: vi.spyOn(engine, 'setKeyword'),
    removeKeyword: vi.spyOn(engine, 'removeKeyword'),
  };
}

describe('KeywordRulesService', () => {
  describe('hasLoaded', () => {
    it('is false until the account’s rules have synced', () => {
      // "You have no keywords" is a positive claim the UI must not make from an
      // empty list that simply has not arrived yet.
      expect(setup({ active: BOB }).svc.hasLoaded()).toBe(false);
    });

    it('is true once they have, so an empty list means the account holds none', () => {
      const { svc } = setup();
      expect(svc.hasLoaded()).toBe(true);
      expect(svc.keywords()).toEqual([]);
    });
  });

  describe('keywords', () => {
    it('lists the account’s keywords, one per word', () => {
      const { svc, engine } = setup();
      engine.writeKeywordRule('trinity', 'trinity');
      engine.writeKeywordRule('oncall', 'oncall');

      expect(svc.keywords()).toEqual([
        { pattern: 'oncall', enabled: true },
        { pattern: 'trinity', enabled: true },
      ]);
    });

    it('reports a keyword another client switched off', () => {
      const { svc, engine } = setup();
      engine.writeKeywordRule('oncall', 'oncall', false);

      expect(svc.keywords()).toEqual([{ pattern: 'oncall', enabled: false }]);
    });

    it('is empty before sign-in', () => {
      expect(setup({ active: null }).svc.keywords()).toEqual([]);
    });

    it('is empty — not a crash — when signed in before the rules have synced', () => {
      // The production ordering: the component's ngOnInit calls keywords() BEFORE
      // hasLoaded(), so a throw on the unsynced path blanks the settings section
      // instead of showing a list that fills in.
      expect(setup({ active: BOB }).svc.keywords()).toEqual([]);
    });
  });

  describe('find', () => {
    it('matches case-insensitively, as the server’s own matching does', () => {
      const { svc, engine } = setup();
      engine.writeKeywordRule('OnCall', 'OnCall');

      expect(svc.find('oncall')?.pattern).toBe('OnCall');
      expect(svc.find('  ONCALL  ')?.pattern).toBe('OnCall');
      expect(svc.find('other')).toBeUndefined();
    });

    it('matches a whole keyword, never a substring of one', () => {
      // A "more forgiving" match would make add('call') resolve to the OnCall rule and
      // re-enable it instead of adding the word that was typed.
      const { svc, engine } = setup();
      engine.writeKeywordRule('OnCall', 'OnCall');

      expect(svc.find('call')).toBeUndefined();
      expect(svc.find('OnCallRota')).toBeUndefined();
    });
  });

  describe('add', () => {
    it('writes a rule keyed by the word, with sound and highlight', async () => {
      // Element keys keyword rules by the word, which is what lets a keyword list
      // round-trip between clients rather than each accumulating duplicates.
      const { svc, engine, alice, setKeyword } = setup();

      await firstValueFrom(svc.add('oncall'));

      expect(setKeyword).toHaveBeenCalledWith(alice, 'oncall');
      expect(engine.keywordActions('oncall')).toEqual(KEYWORD_ACTIONS);
    });

    it('is readable at once, without waiting for the sync echo', async () => {
      // Without this the row the user just added is absent until the m.push_rules
      // account-data echo arrives on sync, so it looks like the add silently failed.
      const { svc } = setup();

      await firstValueFrom(svc.add('oncall'));

      expect(svc.keywords()).toEqual([{ pattern: 'oncall', enabled: true }]);
    });

    it('re-points a differently-cased keyword rather than duplicating it', async () => {
      // Content matching is case-insensitive server-side, so `OnCall` and `oncall`
      // fire on the same messages — two rules would mean two notifications for one word.
      const { svc, engine, alice, removeKeyword, setKeyword } = setup();
      engine.writeKeywordRule('OnCall', 'OnCall', false);
      engine.writeKeywordRule('kw-7f3a', 'ONCALL');

      await firstValueFrom(svc.add('oncall'));

      expect(removeKeyword).toHaveBeenCalledWith(alice, 'OnCall');
      expect(removeKeyword).toHaveBeenCalledWith(alice, 'ONCALL');
      expect(setKeyword).toHaveBeenCalledWith(alice, 'oncall');
      expect(svc.keywords()).toEqual([{ pattern: 'oncall', enabled: true }]);
    });

    it('does not remove anything when the spelling already matches', async () => {
      const { svc, engine, removeKeyword } = setup();
      engine.writeKeywordRule('oncall', 'oncall', false);

      await firstValueFrom(svc.add('oncall'));

      expect(removeKeyword).not.toHaveBeenCalled();
      expect(svc.keywords()).toEqual([{ pattern: 'oncall', enabled: true }]);
    });

    it('keeps the old spelling when adding the new one fails', async () => {
      // The add runs first, so a failed add has removed nothing: the keyword survives.
      const { svc, engine, removeKeyword, setKeyword } = setup();
      engine.writeKeywordRule('OnCall', 'OnCall');
      setKeyword.mockReturnValue(of(REFUSED));

      await expect(firstValueFrom(svc.add('oncall'))).rejects.toBeInstanceOf(
        EngineRequestError,
      );
      expect(removeKeyword).not.toHaveBeenCalled();
      expect(svc.keywords()).toEqual([{ pattern: 'OnCall', enabled: true }]);
    });

    it('reports a failed removal after the add, leaving both spellings enabled', async () => {
      // A harmless duplicate rather than a lost keyword.
      const { svc, engine, removeKeyword } = setup();
      engine.writeKeywordRule('OnCall', 'OnCall');
      removeKeyword.mockReturnValue(of(REFUSED));

      await expect(firstValueFrom(svc.add('oncall'))).rejects.toBeInstanceOf(
        EngineRequestError,
      );
      expect(svc.keywords()).toEqual([
        { pattern: 'oncall', enabled: true },
        { pattern: 'OnCall', enabled: true },
      ]);
    });

    it('never removes the rule just written when the snapshot is stale', async () => {
      // Legacy layout: id `OnCall`, pattern `oncall`. Adding `OnCall` overwrites that rule;
      // if the engine's re-read failed, the snapshot still lists it as `oncall`, and
      // removing `oncall` would delete the rule just written.
      const { svc, engine, removeKeyword, setKeyword } = setup();
      engine.writeKeywordRule('OnCall', 'oncall');
      setKeyword.mockReturnValue(of(engineOk(null)));

      await firstValueFrom(svc.add('OnCall'));

      expect(removeKeyword).not.toHaveBeenCalled();
    });

    it('re-enables a keyword another client had switched off', async () => {
      const { svc, engine } = setup();
      engine.writeKeywordRule('oncall', 'oncall', false);

      await firstValueFrom(svc.add('oncall'));

      expect(svc.keywords()).toEqual([{ pattern: 'oncall', enabled: true }]);
    });

    it('trims the keyword before writing it', async () => {
      const { svc, alice, setKeyword } = setup();

      await firstValueFrom(svc.add('  oncall  '));

      expect(setKeyword).toHaveBeenCalledWith(alice, 'oncall');
    });

    it('rejects an empty or whitespace-only keyword without writing', async () => {
      const { svc, setKeyword } = setup();

      await expect(firstValueFrom(svc.add('   '))).rejects.toThrow(
        'Enter a word',
      );
      expect(setKeyword).not.toHaveBeenCalled();
    });

    it.each(['.net', 'a/b'])(
      'refuses %s, which cannot serve as the rule id',
      async (input) => {
        // A leading dot is the sharp one: the list filters server rules out, so `.net`
        // would be created, would notify, and would be invisible and unremovable.
        const { svc, setKeyword } = setup();

        await expect(firstValueFrom(svc.add(input))).rejects.toBeInstanceOf(
          KeywordValidationError,
        );
        expect(setKeyword).not.toHaveBeenCalled();
      },
    );

    it.each(['*', 'proj*', 'c?ris'])(
      'refuses %s, because a pattern is a glob and the field asks for a word',
      async (input) => {
        // `*` would become "notify on every message in every room", stored on the
        // account, so on every device and in every other client.
        const { svc, setKeyword } = setup();

        // The TYPE is the contract: the component surfaces a service message verbatim
        // only for a KeywordValidationError, so a plain Error here would leave the user
        // with "Could not add" and no idea why.
        await expect(firstValueFrom(svc.add(input))).rejects.toBeInstanceOf(
          KeywordValidationError,
        );
        await expect(firstValueFrom(svc.add(input))).rejects.toThrow(
          'cannot contain',
        );
        expect(setKeyword).not.toHaveBeenCalled();
      },
    );

    it('fails before sign-in without writing', async () => {
      const { svc, setKeyword } = setup({ active: null });

      await expect(firstValueFrom(svc.add('oncall'))).rejects.toThrow(
        'Not signed in.',
      );
      expect(setKeyword).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('deletes every rule for the word, also one keyed by another id', async () => {
      // The spec permits any content-rule id; only Element happens to key by the word.
      const { svc, engine, alice, removeKeyword } = setup();
      engine.writeKeywordRule('kw-7f3a', 'oncall');

      await firstValueFrom(svc.remove('oncall'));

      expect(removeKeyword).toHaveBeenCalledWith(alice, 'oncall');
      expect(svc.keywords()).toEqual([]);
    });

    it('refuses to write before sign-in', async () => {
      // Without the guard the observable dies on the engine's not-live failure instead
      // of saying what is wrong.
      const { svc, removeKeyword } = setup({ active: null });

      await expect(firstValueFrom(svc.remove('oncall'))).rejects.toThrow(
        'Not signed in.',
      );
      expect(removeKeyword).not.toHaveBeenCalled();
    });
  });

  describe('a rejected write', () => {
    it.each([
      ['add', (s: KeywordRulesService) => s.add('oncall')],
      ['remove', (s: KeywordRulesService) => s.remove('oncall')],
    ])('reaches the caller from %s', async (_method, call) => {
      // A swallowed failure makes every failed write report success, so the component
      // never toasts and never re-reads.
      const { svc, setKeyword, removeKeyword } = setup();
      const refused = engineFail({
        kind: 'http',
        code: 'request-failed',
        diagnostic: { kind: 'http', httpStatus: 403 },
      });
      setKeyword.mockReturnValue(of(refused));
      removeKeyword.mockReturnValue(of(refused));

      await expect(firstValueFrom(call(svc))).rejects.toBeInstanceOf(
        EngineRequestError,
      );
    });
  });

  describe('per-account keywords', () => {
    /** Alice holds a keyword while another live account is the active one. */
    function setupOwned() {
      const owned = setup({ active: BOB, live: [BOB, '@alice:fake'] });
      owned.engine.writeKeywordRule('owner-word', 'owner-word');
      return owned;
    }

    it('reads the named account’s keywords, not the active one’s', () => {
      const { svc, alice } = setupOwned();

      expect(svc.keywords(alice).map((k) => k.pattern)).toEqual(['owner-word']);
      expect(svc.keywords()).toEqual([]);
    });

    it('writes to the named account', async () => {
      const { svc, alice, setKeyword } = setupOwned();

      await firstValueFrom(svc.add('oncall', alice));

      expect(setKeyword).toHaveBeenCalledWith(alice, 'oncall');
    });

    it('resolves an existing keyword against the SAME account it writes to', async () => {
      // Resolving on the active account would miss and write a second rule to the owner —
      // two rules matching one word.
      const { svc, alice } = setupOwned();

      await firstValueFrom(svc.add('OWNER-WORD', alice));

      expect(svc.keywords(alice)).toEqual([
        { pattern: 'OWNER-WORD', enabled: true },
      ]);
    });

    it('removes against the named account too', async () => {
      const { svc, alice, removeKeyword } = setupOwned();

      await firstValueFrom(svc.remove('owner-word', alice));

      expect(removeKeyword).toHaveBeenCalledWith(alice, 'owner-word');
      expect(svc.keywords(alice)).toEqual([]);
    });

    it('reports load state per account', () => {
      const { svc, alice } = setupOwned();

      expect(svc.hasLoaded(alice)).toBe(true);
      expect(svc.hasLoaded()).toBe(false); // the active account's rules never loaded
    });
  });
});
