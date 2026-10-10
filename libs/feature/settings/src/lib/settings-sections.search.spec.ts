import { describe, expect, it } from 'vitest';
import { matchingSettingsSections } from './settings-sections';

describe('matchingSettingsSections', () => {
  it('returns one section result per section for an empty query', () => {
    const results = matchingSettingsSections('  ');
    expect(results).toHaveLength(14);
    expect(results.every((result) => result.part === undefined)).toBe(true);
  });

  it('matches section labels and groups as before', () => {
    expect(
      matchingSettingsSections('preferences').map(
        ({ section }) => section.path,
      ),
    ).toEqual(['appearance', 'notifications', 'privacy']);
  });

  it('matches a part by its title', () => {
    const results = matchingSettingsSections('code');
    expect(results).toHaveLength(1);
    expect(results[0].section.path).toBe('appearance');
    expect(results[0].part).toMatchObject({
      id: 'code-blocks',
      label: 'Code blocks',
    });
  });

  it('matches a part of a section that does not match itself', () => {
    const results = matchingSettingsSections('keyword');
    expect(
      results.map(({ section, part }) => [section.path, part?.id]),
    ).toEqual([['notifications', 'keywords']]);
  });

  it('does not repeat a section as its own part', () => {
    const results = matchingSettingsSections('notifications');
    expect(results.map(({ part }) => part)).toEqual([undefined]);
  });
});
