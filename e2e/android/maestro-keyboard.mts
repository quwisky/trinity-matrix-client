import type { MaestroDevice } from './maestro-session.mts';

/** Android keycodes from API 36 attrs.xml; used where Maestro 2.10 has no keyboard-key enum. */
export const ANDROID_KEYCODES = {
  arrowDown: 20,
  arrowLeft: 21,
  arrowRight: 22,
  arrowUp: 19,
  backspace: 67,
  end: 123,
  enter: 66,
  escape: 111,
  forwardDelete: 112,
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

/**
 * Chromium document-boundary commands. Home/End only reach the current visual
 * line of a wrapped textarea; Ctrl+Home/Ctrl+End reach the start/end of its text.
 */
export const ANDROID_KEY_COMBINATIONS = {
  documentStart: [113, 122],
  documentEnd: [113, 123],
} as const;

export type AndroidKeyCombination = keyof typeof ANDROID_KEY_COMBINATIONS;

/** Press one native key chord (API 33+ `input keycombination`) through the device lease. */
export async function pressAndroidKeyCombination(
  device: MaestroDevice,
  combination: AndroidKeyCombination,
): Promise<void> {
  await device.adb(
    'shell',
    'input',
    'keycombination',
    ...ANDROID_KEY_COMBINATIONS[combination].map(String),
  );
}
