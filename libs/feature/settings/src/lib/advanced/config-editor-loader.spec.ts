import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopBridgeFixture } from '@trinity/testing';
import {
  CONFIG_EDITOR_LOADER,
  provideConfigEditor,
  supportsConfigEditor,
} from './config-editor-loader';

/** Put the Electron preload marker on `globalThis`, the way the desktop shell does. */
function pretendDesktop(): void {
  (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
    desktopBridgeFixture();
}

describe('config editor loader', () => {
  afterEach(() => {
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
    vi.restoreAllMocks();
  });

  it('offers the editor on the web', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);

    expect(supportsConfigEditor()).toBe(true);
  });

  it('offers the editor on the desktop shell, which Capacitor calls non-native', () => {
    // The trap this reads around: `isNativePlatform()` is FALSE in Electron, so a naive
    // `isNativePlatform()` check happens to include desktop — and would stop doing so the
    // moment Capacitor reported the shell as native. The marker is what keeps desktop in.
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    pretendDesktop();

    expect(supportsConfigEditor()).toBe(true);
  });

  it('does not offer it in the mobile app', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);

    expect(supportsConfigEditor()).toBe(false);
  });

  it('gives the mobile app no loader at all, so the chunk is never even requested', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    TestBed.configureTestingModule({ providers: [provideConfigEditor()] });

    // Not "a loader that refuses": nothing to call, so the dynamic `import()` inside it
    // cannot run. That is the whole of the promise made about native.
    expect(TestBed.inject(CONFIG_EDITOR_LOADER)).toBeNull();
  });

  it('loads a real component from the editor chunk on the platforms that get one', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    TestBed.configureTestingModule({ providers: [provideConfigEditor()] });

    const load = TestBed.inject(CONFIG_EDITOR_LOADER);
    const component = await load?.();

    // Resolves the import for real, so renaming the module or its export fails here rather
    // than at runtime on the one page that uses it.
    expect(component?.name).toBe('ConfigEditorComponent');
  });
});
