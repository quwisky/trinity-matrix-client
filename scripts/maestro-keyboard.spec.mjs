import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  pressAndroidKeyCombination,
  pressAndroidKeyboardKey,
} from '../e2e/android/maestro-keyboard.mts';

const device = (adb) => ({ adb });

describe('native Android keyboard adapter', () => {
  it.each([
    ['arrowUp', 19],
    ['arrowDown', 20],
    ['arrowLeft', 21],
    ['arrowRight', 22],
    ['home', 122],
    ['end', 123],
    ['enter', 66],
    ['space', 62],
    ['tab', 61],
    ['escape', 111],
  ])('dispatches the exact native keyevent for %s', async (key, code) => {
    const adb = vi.fn().mockResolvedValue('');

    await pressAndroidKeyboardKey(device(adb), key);

    expect(adb).toHaveBeenCalledOnce();
    expect(adb).toHaveBeenCalledWith(
      'shell',
      'input',
      'keyevent',
      String(code),
    );
  });

  it('propagates a device failure without dispatching a retry', async () => {
    const failure = new Error('adb keyevent failed');
    const adb = vi.fn().mockRejectedValue(failure);

    await expect(
      pressAndroidKeyboardKey(device(adb), 'arrowDown'),
    ).rejects.toBe(failure);
    expect(adb).toHaveBeenCalledOnce();
  });

  it.each([
    ['documentStart', ['113', '122']],
    ['documentEnd', ['113', '123']],
  ])(
    'dispatches the exact native Ctrl chord for %s',
    async (combination, codes) => {
      const adb = vi.fn().mockResolvedValue('');

      await pressAndroidKeyCombination(device(adb), combination);

      expect(adb).toHaveBeenCalledOnce();
      expect(adb).toHaveBeenCalledWith(
        'shell',
        'input',
        'keycombination',
        ...codes,
      );
    },
  );

  it('reaches wrapped text boundaries in the focused fill', () => {
    const client = readFileSync(
      resolve(
        import.meta.dirname,
        '../e2e/android/account-workspace-client.mts',
      ),
      'utf8',
    );
    const fill = client.slice(
      client.indexOf('async fillFocused('),
      client.indexOf(
        "await this.key('space');",
        client.indexOf('async fillFocused('),
      ),
    );
    expect(fill).toContain("await this.keyCombination('documentStart');");
    expect(fill).toContain("await this.keyCombination('documentEnd');");
    expect(fill).not.toContain("await this.key('home');");
    expect(fill).not.toContain("await this.key('end');");
  });
});
