import { Capacitor } from '@capacitor/core';
import { isElectronRenderer } from '../trinity-desktop-bridge';

/** Keyboard-and-pointer editing capability, independent of a named host identity. */
export function supportsRichConfigEditing(): boolean {
  return isElectronRenderer() || !Capacitor.isNativePlatform();
}
