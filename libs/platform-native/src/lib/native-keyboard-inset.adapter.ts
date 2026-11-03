import { DOCUMENT, Injectable, inject } from '@angular/core';
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { EMPTY, Observable, defer } from 'rxjs';
import { isNativeIos } from './mobile-os';

const KEYBOARD_INSET = '--trinity-keyboard-inset';
const KEYBOARD_DURATION = '--trinity-keyboard-duration';
const KEYBOARD_EASING = '--trinity-keyboard-easing';
const KEYBOARD_DELAY = '--trinity-keyboard-delay';
// The keyboard starts moving a frame or two before the page's response reaches the screen
// (Simulator recordings, #1868). Starting each move that far into its curve keeps the layout on
// the keyboard's top edge instead of under it (show) or behind it (hide).
// Measured at 60 Hz web frames, so a fixed time rather than a share of the move.
const SHOW_HEAD_START = '-16ms';
const HIDE_HEAD_START = '-33ms';

/** The covered height in CSS px, the move's duration in seconds and its `UIView.AnimationCurve`. */
interface KeyboardFrame {
  readonly height: number;
  /** Absent when the notification carries none; the stylesheet's default applies. */
  readonly duration?: number;
  readonly curve: number;
}

interface KeyboardFramePlugin {
  addListener(
    event: 'keyboardFrame',
    listener: (frame: KeyboardFrame) => void,
  ): Promise<PluginListenerHandle>;
}

const keyboardFrame = registerPlugin<KeyboardFramePlugin>('KeyboardFrame');

// The keyboard's own curve (7) is private; it keeps the fitted default in variables.scss.
const PUBLIC_CURVES: Readonly<Record<number, string>> = {
  0: 'ease-in-out',
  1: 'ease-in',
  2: 'ease-out',
  3: 'linear',
};

/**
 * iOS keeps the WebView full height while the keyboard shows (`resize: 'none'`), so the app
 * shrinks itself: as the keyboard starts to move, this writes the height it will cover to
 * `--trinity-keyboard-inset` on `<html>`, with that move's duration and curve, and the layout
 * animates alongside it. Elsewhere the variable keeps its 0px default and the host resizes the
 * WebView.
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
      let last = 0;
      const handle = keyboardFrame
        .addListener('keyboardFrame', ({ height, duration, curve }) => {
          if (typeof duration === 'number')
            root.style.setProperty(
              KEYBOARD_DURATION,
              `${Math.round(duration * 1000)}ms`,
            );
          else root.style.removeProperty(KEYBOARD_DURATION);
          root.style.setProperty(
            KEYBOARD_DELAY,
            height >= last ? SHOW_HEAD_START : HIDE_HEAD_START,
          );
          last = height;
          const easing = PUBLIC_CURVES[curve];
          if (easing) root.style.setProperty(KEYBOARD_EASING, easing);
          else root.style.removeProperty(KEYBOARD_EASING);
          root.style.setProperty(KEYBOARD_INSET, `${height}px`);
        })
        .catch(() => undefined);
      return () => {
        void handle.then((h) => h?.remove()).catch(() => undefined);
        for (const property of [
          KEYBOARD_INSET,
          KEYBOARD_DURATION,
          KEYBOARD_EASING,
          KEYBOARD_DELAY,
        ]) {
          root.style.removeProperty(property);
        }
      };
    });
  }
}
