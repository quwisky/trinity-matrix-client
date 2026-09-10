import { describe, expect, it, vi } from 'vitest';
import { pressAndroidKeyboardKey } from '../e2e/android/maestro-keyboard.mts';

const device = (adb) => ({ adb });

describe('native Android keyboard adapter', () => {
  it.each([
    ['arrowUp', 19],
    ['arrowDown', 20],
    ['arrowLeft', 21],
    ['arrowRight', 22],
    ['home', 122],
    ['end', 123],
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
});
