import type { MaestroDevice } from './maestro-session.mts';

/** Android keycodes from API 36 attrs.xml; used where Maestro 2.10 has no keyboard-key enum. */
export const ANDROID_KEYCODES = {
  arrowDown: 20,
  arrowLeft: 21,
  arrowRight: 22,
  arrowUp: 19,
  end: 123,
  escape: 111,
  home: 122,
  space: 62,
  tab: 61,
} as const;

export type AndroidKeyboardKey = keyof typeof ANDROID_KEYCODES;

/** Send one native Android key event through the invocation-owned device lease. */
export async function pressAndroidKeyboardKey(
  device: MaestroDevice,
  key: AndroidKeyboardKey,
): Promise<void> {
  await device.adb(
    'shell',
    'input',
    'keyevent',
    String(ANDROID_KEYCODES[key]),
  );
}
