import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const read = (path) => readFileSync(join(workspaceRoot, path), 'utf8');
const javaDir = 'android/app/src/main/java/dev/trinityproject/trinity';

/**
 * Structural coverage for the Android half of the call session host: Linux CI cannot run the
 * service, so this keeps the plugin registered under the name Angular calls and the service
 * declared with the types and permissions Android 14+ checks. Behaviour proof is on the emulator.
 */
describe('call session bridge', () => {
  it('registers the CallSession plugin before the bridge starts', () => {
    const plugin = read(`${javaDir}/CallSessionPlugin.java`);
    const activity = read(`${javaDir}/MainActivity.java`);

    expect(plugin).toContain('@CapacitorPlugin(name = "CallSession")');
    expect(plugin).toContain('public void begin(PluginCall call)');
    expect(plugin).toContain('public void end(PluginCall call)');
    expect(plugin).toContain('notifyListeners("hangUp"');
    const register = activity.indexOf(
      'registerPlugin(CallSessionPlugin.class)',
    );
    expect(register).toBeGreaterThan(-1);
    expect(register).toBeLessThan(
      activity.indexOf('super.onCreate(savedInstanceState)'),
    );
  });

  it('declares the foreground service with its types and permissions', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');

    expect(manifest).toMatch(
      /<service\s+android:name="\.CallSessionService"\s+android:exported="false"\s+android:foregroundServiceType="microphone\|camera\|mediaPlayback"/,
    );
    for (const permission of [
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_MICROPHONE',
      'FOREGROUND_SERVICE_CAMERA',
      'FOREGROUND_SERVICE_MEDIA_PLAYBACK',
      'POST_NOTIFICATIONS',
    ]) {
      expect(manifest).toContain(
        `<uses-permission android:name="android.permission.${permission}" />`,
      );
    }
  });

  it('stops the service when the task is removed', () => {
    const service = read(`${javaDir}/CallSessionService.java`);

    expect(service).toMatch(
      /onTaskRemoved\(Intent rootIntent\)\s*\{\s*stopSelf\(\);/,
    );
  });
});
