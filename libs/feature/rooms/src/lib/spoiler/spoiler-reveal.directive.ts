import { Directive } from '@angular/core';
import { Subject, type Observable } from 'rxjs';

/** Marks a spoiler element the user has chosen to uncover (drives the CSS reveal). */
const REVEALED_CLASS = 'is-revealed';

/**
 * Click- (and keyboard-) to-reveal for spoiler content inside a rendered message body.
 * The sanitizer tags spoilers with the `mx-spoiler` class (Angular's `[innerHTML]`
 * sanitizer strips the original `data-mx-spoiler` attribute, so the class is what
 * survives to the DOM). The body is set via `[innerHTML]`, so spoilers have no Angular
 * bindings of their own — this directive listens on the container and reveals the
 * nearest concealed spoiler when it is activated. The revealing activation is
 * swallowed (preventDefault/stop) so a first click that lands on a link *inside* a
 * spoiler only uncovers it rather than also following the link; once revealed, the
 * spoiler behaves like normal content.
 */
@Directive({
  selector: '[trnSpoilerReveal]',
  host: {
    '(click)': 'onClick($event)',
    '(keydown.enter)': 'onKey($event)',
    '(keydown.space)': 'onKey($event)',
    '(focusout)': 'onFocusOut($event)',
  },
})
export class SpoilerRevealDirective {
  private readonly revealedSpoilers = new Subject<HTMLElement>();

  /**
   * Each spoiler as it is revealed. InlineMxcImagesDirective, composed on the same element,
   * starts fetching the images inside it only then.
   */
  readonly revealed: Observable<HTMLElement> =
    this.revealedSpoilers.asObservable();

  // Angular types host-binding `$event` as the base `Event`, so accept that and read
  // the fields (`target`, `preventDefault`, `stopPropagation`) common to both.
  onClick(event: Event): void {
    const spoiler = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      '.mx-spoiler',
    );
    this.reveal(spoiler, event);
  }

  onKey(event: Event): void {
    // Only when the spoiler itself is focused (tabindex is set on it in the sanitizer).
    const target = event.target as HTMLElement | null;
    this.reveal(target?.closest<HTMLElement>('.mx-spoiler'), event);
  }

  onFocusOut(event: Event): void {
    // A spoiler revealed while focused kept its tab stop (see reveal); drop it once focus leaves.
    const target = event.target as HTMLElement | null;
    if (target?.matches(`.mx-spoiler.${REVEALED_CLASS}`)) {
      target.removeAttribute('tabindex');
    }
  }

  private reveal(spoiler: HTMLElement | null | undefined, event: Event): void {
    if (!spoiler || spoiler.classList.contains(REVEALED_CLASS)) {
      return; // no spoiler here, or it is already uncovered — let the event proceed
    }
    event.preventDefault();
    event.stopPropagation();
    spoiler.classList.add(REVEALED_CLASS);
    // Revealed content is ordinary text again: no button and no name hiding it.
    spoiler.removeAttribute('aria-label');
    spoiler.removeAttribute('role');
    this.revealedSpoilers.next(spoiler);
    // Removing the tab stop of the focused element would drop focus to <body>, so a
    // keyboard reveal keeps it until focus leaves (onFocusOut).
    if (spoiler.ownerDocument.activeElement !== spoiler) {
      spoiler.removeAttribute('tabindex');
    }
  }
}
