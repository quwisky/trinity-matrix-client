import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const read = (path) => readFileSync(join(workspaceRoot, path), 'utf8');

/**
 * Structural coverage for the native half of "Open settings" (#919). Like the navigation
 * gesture bridge, it cannot compile Swift or Java on Linux CI; it keeps the hand-written
 * plugins registered under the name Angular calls. Launch proof stays on the host.
 */
describe('app settings bridge', () => {
  it('registers an iOS instance plugin named AppSettings that opens the settings URL', () => {
    const swift = read('ios/App/App/MainViewController.swift');

    expect(swift).toMatch(
      /class AppSettingsPlugin:\s*CAPInstancePlugin,\s*CAPBridgedPlugin/,
    );
    expect(swift).toContain('let jsName = "AppSettings"');
    expect(swift).toContain(
      'CAPPluginMethod(name: "openAppSettings", returnType: CAPPluginReturnPromise)',
    );
    expect(swift).toContain('UIApplication.openSettingsURLString');
    expect(swift).toContain(
      'bridge?.registerPluginInstance(AppSettingsPlugin())',
    );
  });

  it('registers the Android plugin before the bridge starts and opens application details', () => {
    const plugin = read(
      'android/app/src/main/java/eu/qwky/trinity/AppSettingsPlugin.java',
    );
    const activity = read(
      'android/app/src/main/java/eu/qwky/trinity/MainActivity.java',
    );

    expect(plugin).toContain('@CapacitorPlugin(name = "AppSettings")');
    expect(plugin).toContain('public void openAppSettings(PluginCall call)');
    expect(plugin).toContain('Settings.ACTION_APPLICATION_DETAILS_SETTINGS');
    const register = activity.indexOf(
      'registerPlugin(AppSettingsPlugin.class)',
    );
    const start = activity.indexOf('super.onCreate(savedInstanceState)');
    expect(register).toBeGreaterThan(-1);
    expect(register).toBeLessThan(start);
  });
});
