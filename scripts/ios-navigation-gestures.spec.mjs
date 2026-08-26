import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const source = readFileSync(
  join(workspaceRoot, 'ios/App/App/MainViewController.swift'),
  'utf8',
);

/**
 * Structural coverage for the native half of the Angular/iOS gesture contract.
 *
 * This deliberately does not pretend to compile Swift or exercise WebKit. Its job is to
 * keep the hand-written Capacitor bridge registered and fail-safe in a tree whose normal
 * Linux CI cannot see either mistake. The simulator/device acceptance run remains separate.
 */
describe('iOS navigation gesture bridge', () => {
  it('registers an instance plugin with the JavaScript name Angular calls', () => {
    expect(source).toMatch(
      /class NativeNavigationPlugin:\s*CAPInstancePlugin,\s*CAPBridgedPlugin/,
    );
    expect(source).toContain('let jsName = "NativeNavigation"');
    expect(source).toContain(
      'CAPPluginMethod(name: "setGesturesEnabled", returnType: CAPPluginReturnPromise)',
    );
    expect(source).toContain(
      'bridge?.registerPluginInstance(NativeNavigationPlugin())',
    );
  });

  it('starts fail-safe and only mutates WebKit on the main queue', () => {
    expect(source).toContain(
      'webView?.allowsBackForwardNavigationGestures = false',
    );
    expect(source).toContain('DispatchQueue.main.async');
    expect(source).toContain(
      'self?.bridge?.webView?.allowsBackForwardNavigationGestures = enabled',
    );
  });
});
