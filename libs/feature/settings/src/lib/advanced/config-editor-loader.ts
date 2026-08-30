import {
  InjectionToken,
  makeEnvironmentProviders,
  type EnvironmentProviders,
  type OutputRef,
  type Type,
} from '@angular/core';
import { supportsRichConfigEditing } from '@trinity/platform-native';

/**
 * What the Advanced section needs of the rich editor, without importing it.
 *
 * The interface is the seam: this file is in the settings chunk and names only a type, so
 * nothing here drags CodeMirror in. The one `import()` below is the only reference to the
 * editor's module in the whole workspace, which is what puts it — and its ~430 kB of editor —
 * in a chunk of its own.
 */
export interface ConfigEditorHost {
  /** The document as the user has typed it, on every keystroke that changes it. */
  readonly edited: OutputRef<string>;
}

/** Fetch the editor's chunk and hand back the component in it. */
export type ConfigEditorLoader = () => Promise<Type<ConfigEditorHost>>;

/**
 * The rich editor, or `null` where it is not offered.
 *
 * Injected `{ optional: true }` by the section, in the `ENCRYPTION_DIALOG_COMPONENTS` idiom
 * this repo already uses for a lazily-loaded surface a lib may not import: absent, the section
 * falls back to its plain textarea, so rendering it without any wiring — a spec, a story —
 * still works and still edits.
 */
export const CONFIG_EDITOR_LOADER =
  new InjectionToken<ConfigEditorLoader | null>('CONFIG_EDITOR_LOADER');

/**
 * Whether this platform gets the rich editor: web and desktop, not the mobile app.
 *
 * **`Capacitor.isNativePlatform()` is FALSE inside the Electron shell**, so the desktop marker
 * is what keeps desktop *in*, not what keeps it out — read the two together and desktop is
 * covered whichever way Capacitor reports it. On Capacitor native the Advanced section stays
 * the read-only view with Copy and Reset: a code editor with completion and a hover card is a
 * keyboard-and-pointer surface, and a phone keyboard over a 200-line JSON document is a worse
 * way to change one setting than the switch that owns it.
 *
 * Native ships the same `www/` build, so the chunk is on disk in the app bundle either way.
 * What this guarantees is narrower and is the part that costs anything: native never *calls*
 * the loader, so the chunk is never fetched, parsed or executed there.
 */
export function supportsConfigEditor(): boolean {
  return supportsRichConfigEditing();
}

/**
 * The only reference to the editor module in the workspace — a dynamic import, so the bundler
 * splits it off and nothing loads it until the Advanced section is actually opened.
 */
const loadConfigEditor: ConfigEditorLoader = async () =>
  (await import('./config-editor/config-editor.component'))
    .ConfigEditorComponent;

/**
 * Offer the rich editor to the Advanced route, on the platforms that get it.
 *
 * The platform question is answered here, once, rather than inside the component: on native
 * the token resolves to `null` and the loader is never called, so the import cannot run.
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
