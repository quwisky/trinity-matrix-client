import { DOCUMENT, Injectable, inject } from '@angular/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';
import { EMPTY, Observable, defer } from 'rxjs';
import { isNativeIos } from './mobile-os';

const KEYBOARD_INSET = '--trinity-keyboard-inset';

/**
 * iOS keeps the WebView full height while the keyboard shows (`resize: 'none'`), so the app
 * shrinks itself: this writes the keyboard height to `--trinity-keyboard-inset` on `<html>` as
 * the keyboard starts to move, and the layout animates alongside it. Elsewhere the variable
 * keeps its 0px default and the host resizes the WebView.
 */
@Injectable({ providedIn: 'root' })
export class NativeKeyboardInsetAdapter {
  private readonly document = inject(DOCUMENT);

  run(): Observable<never> {
    return defer(() => (isNativeIos() ? this.listen() : EMPTY));
  }

  private listen(): Observable<never> {
    return new Observable<never>(() => {
      const root = this.document.documentElement;
      const handles: Promise<PluginListenerHandle | void>[] = [
        Keyboard.addListener('keyboardWillShow', ({ keyboardHeight }) =>
          root.style.setProperty(KEYBOARD_INSET, `${keyboardHeight}px`),
        ),
        Keyboard.addListener('keyboardWillHide', () =>
          root.style.setProperty(KEYBOARD_INSET, '0px'),
        ),
      ].map((handle) => handle.catch(() => undefined));
      return () => {
        for (const handle of handles) {
          void handle.then((h) => h?.remove()).catch(() => undefined);
        }
        root.style.removeProperty(KEYBOARD_INSET);
      };
    });
  }
}
