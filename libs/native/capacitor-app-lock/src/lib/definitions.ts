/** The name both hosts register the plugin under: iOS `jsName`, Android `@CapacitorPlugin`. */
export const APP_LOCK_PLUGIN_NAME = 'TrinityAppLock';

/** The native plugin's calls. The PIN is passed once per call and never returned. */
export interface AppLockPlugin {
  pinStatus(): Promise<{ set: boolean; nextAttemptAt: number | null }>;
  setPin(options: { pin: string }): Promise<void>;
  verifyPin(options: { pin: string }): Promise<{
    result: 'verified' | 'failed' | 'delayed' | 'invalid' | 'unavailable';
    nextAttemptAt: number | null;
  }>;
  clearPin(): Promise<void>;
  /** iOS: dismiss whatever Trinity presented over the web view; Android resolves at once. */
  dismissPresented(): Promise<void>;
}
