import { describe, expect, it, vi } from 'vitest';
import {
  choiceSetting,
  describeConfigValue,
  flagSetting,
  isConfigRecord,
  listOptions,
  textSetting,
} from './config-validation';

type Size = 'small' | 'large';
const isSize = (value: string): value is Size =>
  value === 'small' || value === 'large';

describe('describeConfigValue', () => {
  it('quotes text and describes everything else by its kind', () => {
    expect(describeConfigValue('mauve')).toBe("'mauve'");
    expect(describeConfigValue(7)).toBe('7');
    expect(describeConfigValue(true)).toBe('true');
    expect(describeConfigValue(null)).toBe('null');
    expect(describeConfigValue(undefined)).toBe('nothing');
    expect(describeConfigValue([1])).toBe('a list');
    expect(describeConfigValue({})).toBe('an object');
  });

  it('truncates a pasted essay rather than putting it in the message', () => {
    const described = describeConfigValue('x'.repeat(500));

    expect(described.length).toBeLessThan(50);
    expect(described.endsWith("…'")).toBe(true);
  });
});

describe('listOptions', () => {
  it('reads as a sentence', () => {
    expect(listOptions(['system', 'light', 'dark'])).toBe(
      'system, light or dark',
    );
    expect(listOptions(['tenor'])).toBe('tenor');
  });
});

describe('isConfigRecord', () => {
  it('accepts only a plain JSON object', () => {
    expect(isConfigRecord({ a: 1 })).toBe(true);
    expect(isConfigRecord([])).toBe(false);
    expect(isConfigRecord(null)).toBe(false);
    expect(isConfigRecord('{}')).toBe(false);
  });
});

describe('choiceSetting', () => {
  const build = () => {
    const set = vi.fn<(value: Size) => void>();
    return {
      set,
      setting: choiceSetting({
        isValid: isSize,
        options: ['small', 'large'],
        noun: 'a text size',
        set,
      }),
    };
  };

  it('accepts a known id', () => {
    expect(build().setting.validate('large')).toEqual({
      ok: true,
      value: 'large',
    });
  });

  it('says what is wrong with the value and what was expected', () => {
    const outcome = build().setting.validate('enormous');

    expect(outcome).toEqual({
      ok: false,
      problem: "'enormous' is not a text size (expected small or large)",
    });
  });

  it('refuses a value of the wrong type outright', () => {
    expect(build().setting.validate(1).ok).toBe(false);
    expect(build().setting.validate(null).ok).toBe(false);
  });

  it('writes through the owning setter', () => {
    const { set, setting } = build();

    setting.write('small');

    expect(set).toHaveBeenCalledWith('small');
  });

  it('writes nothing for a value that would not have validated', () => {
    const { set, setting } = build();

    setting.write('enormous');

    expect(set).not.toHaveBeenCalled();
  });
});

describe('flagSetting', () => {
  it('takes true and false, and nothing that merely looks like them', () => {
    const setting = flagSetting(() => undefined);

    expect(setting.validate(false)).toEqual({ ok: true, value: false });
    expect(setting.validate('true')).toEqual({
      ok: false,
      problem: "'true' is not true or false",
    });
    expect(setting.validate(1).ok).toBe(false);
  });

  it('writes through the owning setter', () => {
    const set = vi.fn<(on: boolean) => void>();

    flagSetting(set).write(true);

    expect(set).toHaveBeenCalledWith(true);
  });
});

describe('textSetting', () => {
  const setting = (maxLength = 10) =>
    textSetting({ maxLength, set: () => undefined });

  it('reports the trimmed value, which is what gets stored', () => {
    expect(setting().validate('  abc  ')).toEqual({ ok: true, value: 'abc' });
  });

  it('refuses anything that is not text', () => {
    expect(setting().validate(7)).toEqual({
      ok: false,
      problem: '7 is not text',
    });
  });

  it('refuses a value past its length, so a paste cannot land in storage', () => {
    const outcome = setting(4).validate('far too long');

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.problem).toContain('4 characters');
  });

  it('writes the trimmed value', () => {
    const set = vi.fn<(value: string) => void>();

    textSetting({ maxLength: 10, set }).write('  abc  ');

    expect(set).toHaveBeenCalledWith('abc');
  });
});
