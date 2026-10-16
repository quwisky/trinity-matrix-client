import {
  InjectionToken,
  makeEnvironmentProviders,
  type EnvironmentProviders,
  type OutputRef,
  type Type,
} from '@angular/core';
import { supportsRichConfigEditing } from '@trinity/platform-native';
import { defer, map, type Observable } from 'rxjs';

/**
 * What the Advanced section needs of the rich editor, without importing it.
 *
 * Only a type is named here, so nothing in the settings chunk drags CodeMirror in. The one
 * `import()` below is the workspace's only reference to the editor module, which keeps its
 * ~430 kB in a chunk of its own.
 */
export interface ConfigEditorHost {
  /** The document as the user has typed it, on every keystroke that changes it. */
  readonly edited: OutputRef<string>;
}

/** Fetch the editor's chunk and hand back the component in it. */
export type ConfigEditorLoader = () => Observable<Type<ConfigEditorHost>>;

/**
 * The rich editor, or `null` where it is not offered.
 *
 * Injected `{ optional: true }` in the `ENCRYPTION_DIALOG_COMPONENTS` idiom: absent, the
 * section falls back to its textarea, so a spec or story with no wiring still renders and edits.
 */
export const CONFIG_EDITOR_LOADER =
  new InjectionToken<ConfigEditorLoader | null>('CONFIG_EDITOR_LOADER');

/**
 * Whether this platform gets the rich editor: web and desktop, not the mobile app.
 *
 * `Capacitor.isNativePlatform()` is FALSE inside the Electron shell, so the desktop marker is
 * what keeps desktop in; read together, desktop is covered whichever way Capacitor reports it.
 * On Capacitor native the section stays read-only with Copy and Reset: a phone keyboard over
 * a 200-line JSON document is a worse way to change a setting than the switch that owns it.
 *
 * Native ships the same `www/` build, so the chunk is on disk either way; what this guarantees
 * is that native never *calls* the loader, so the chunk is never fetched, parsed or executed.
 */
export function supportsConfigEditor(): boolean {
  return supportsRichConfigEditing();
}

/**
 * The only reference to the editor module in the workspace — a dynamic import, so the bundler
 * splits it off and nothing loads it until the Advanced section is actually opened.
 */
const loadConfigEditor: ConfigEditorLoader = () =>
  defer(() => import('./config-editor/config-editor.component')).pipe(
    map((module) => module.ConfigEditorComponent),
  );

/**
 * Offer the rich editor to the Advanced route, on the platforms that get it.
 *
 * Decided once here: on native the token resolves to `null` and the loader never runs.
 */
export function provideConfigEditor(): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: CONFIG_EDITOR_LOADER,
      useFactory: (): ConfigEditorLoader | null =>
        supportsConfigEditor() ? loadConfigEditor : null,
    },
  ]);
}
