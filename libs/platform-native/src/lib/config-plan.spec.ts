import { describe, expect, it } from 'vitest';
import {
  describeConfigChange,
  planConfigApply,
  type ConfigApplyPlan,
} from './config-plan';
import type {
  ConfigEntry,
  ConfigValidation,
  ConfigValue,
} from './config-schema';

/** A setting that takes any text, standing in for the real registry. */
function textEntry(path: string, current: ConfigValue): ConfigEntry {
  return entry(path, current, (value) =>
    typeof value === 'string'
      ? { ok: true, value }
      : { ok: false, problem: `${String(value)} is not text` },
  );
}

function entry(
  path: string,
  current: ConfigValue,
  validate: (value: unknown) => ConfigValidation,
): ConfigEntry {
  return {
    path,
    key: `stored:${path}`,
    read: () => current,
    reset: () => undefined,
    write: () => undefined,
    validate,
  };
}

/** A well-formed envelope around `settings`. */
function document(settings: unknown, version = 1): unknown {
  return { version, exportedAt: '2026-08-09T00:00:00.000Z', settings };
}

function problems(plan: ConfigApplyPlan): readonly string[] {
  return plan.ok ? [] : plan.problems;
}

describe('planConfigApply', () => {
  const registry = [
    textEntry('theme.palette', 'trinity'),
    textEntry('theme.mode', 'system'),
  ];

  describe('the envelope', () => {
    it('refuses anything that is not an object', () => {
      for (const notADocument of ['{}', 42, null, [1, 2]]) {
        expect(planConfigApply(notADocument, registry).ok).toBe(false);
      }
    });

    it('refuses a document with no version, which is what tells old from broken', () => {
      const plan = planConfigApply({ settings: {} }, registry);

      expect(plan.ok).toBe(false);
      expect(problems(plan)[0]).toContain('version');
    });

    it('refuses a version that is not a whole number from 1 up', () => {
      expect(planConfigApply(document({}, 0), registry).ok).toBe(false);
      expect(planConfigApply(document({}, 1.5), registry).ok).toBe(false);
    });

    it('refuses a document with no settings block', () => {
      const plan = planConfigApply({ version: 1, settings: 'nope' }, registry);

      expect(plan.ok).toBe(false);
      expect(problems(plan)[0]).toContain('settings');
    });

    it('warns about a newer format but applies what it understands', () => {
      const plan = planConfigApply(
        document({ theme: { palette: 'amethyst' } }, 2),
        registry,
      );

      expect(plan.ok).toBe(true);
      expect(plan.warnings[0]).toContain('newer version');
      expect(plan.warnings[0]).toContain('version 2');
      expect(plan.ok && plan.changes).toEqual([
        { path: 'theme.palette', from: 'trinity', to: 'amethyst' },
      ]);
    });
  });

  describe('a value its setting refuses', () => {
    it('takes the whole document down, naming the offending path', () => {
      const plan = planConfigApply(
        document({ theme: { palette: 7, mode: 'dark' } }),
        registry,
      );

      expect(plan.ok).toBe(false);
      expect(problems(plan)).toEqual(['theme.palette: 7 is not text']);
    });

    it('leaves no change behind for the settings that were fine', () => {
      const plan = planConfigApply(
        document({ theme: { palette: 7, mode: 'dark' } }),
        registry,
      );

      // A rejected plan carries no changes at all — there is no way to apply half of it.
      expect('changes' in plan).toBe(false);
    });

    it('names every offending path, not just the first', () => {
      const plan = planConfigApply(
        document({ theme: { palette: 7, mode: false } }),
        registry,
      );

      expect(problems(plan)).toHaveLength(2);
    });
  });

  describe('a path this build does not know', () => {
    it('warns and applies the rest, rather than silently dropping it', () => {
      const plan = planConfigApply(
        document({
          theme: { palette: 'amethyst', shadows: 'soft' },
          weather: { rain: true },
        }),
        registry,
      );

      expect(plan.ok).toBe(true);
      expect(plan.warnings).toEqual([
        'theme.shadows is not a setting this version of Trinity has, so it will not be applied.',
        'weather.rain is not a setting this version of Trinity has, so it will not be applied.',
      ]);
      expect(plan.ok && plan.changes.map((change) => change.path)).toEqual([
        'theme.palette',
      ]);
    });

    it('stops descending at a setting whose own value is an object', () => {
      const withObject = [
        entry('shortcuts.overrides', {}, (value) => ({
          ok: true,
          value: value as ConfigValue,
        })),
      ];

      const plan = planConfigApply(
        document({ shortcuts: { overrides: { 'switcher.open': null } } }),
        withObject,
      );

      // `shortcuts.overrides.switcher.open` is a field of a value, not a path of its own.
      expect(plan.warnings).toEqual([]);
      expect(plan.ok && plan.changes[0].to).toEqual({ 'switcher.open': null });
    });
  });

  describe('the change summary', () => {
    it('lists exactly the settings that move, and where to', () => {
      const plan = planConfigApply(
        document({ theme: { palette: 'amethyst', mode: 'system' } }),
        registry,
      );

      expect(plan.ok && plan.changes).toEqual([
        { path: 'theme.palette', from: 'trinity', to: 'amethyst' },
      ]);
    });

    it('is empty for a document that matches the app', () => {
      const plan = planConfigApply(
        document({ theme: { palette: 'trinity', mode: 'system' } }),
        registry,
      );

      expect(plan.ok && plan.changes).toEqual([]);
    });

    it('leaves a setting the document omits alone', () => {
      const plan = planConfigApply(document({}), registry);

      expect(plan.ok && plan.changes).toEqual([]);
    });

    it('reports the value that will be stored, not the one that was typed', () => {
      const trimming = [
        entry('gif.apiKey', '', (value) => ({
          ok: true,
          value: String(value).trim(),
        })),
      ];

      const plan = planConfigApply(
        document({ gif: { apiKey: '  abc  ' } }),
        trimming,
      );

      expect(plan.ok && plan.changes[0].to).toBe('abc');
    });

    it('does not call an object changed because its keys were written in another order', () => {
      const chords = [
        entry(
          'shortcuts.overrides',
          { open: { accel: true, key: 'k' } },
          (value) => ({ ok: true, value: value as ConfigValue }),
        ),
      ];

      const plan = planConfigApply(
        document({
          shortcuts: { overrides: { open: { key: 'k', accel: true } } },
        }),
        chords,
      );

      expect(plan.ok && plan.changes).toEqual([]);
    });

    it('reads as one line per change', () => {
      expect(
        describeConfigChange({
          path: 'theme.palette',
          from: 'trinity',
          to: 'amethyst',
        }),
      ).toBe('theme.palette: "trinity" → "amethyst"');
    });
  });

  it("passes on a setting's own warning, prefixed with its path", () => {
    const inert = [
      entry('push.gateway', null, () => ({
        ok: true,
        value: null,
        warning: 'does nothing here',
      })),
    ];

    const plan = planConfigApply(document({ push: { gateway: null } }), inert);

    expect(plan.warnings).toEqual(['push.gateway: does nothing here']);
  });
});
