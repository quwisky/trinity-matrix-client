import { describe, expect, it, vi } from 'vitest';
import { SpoilerRevealDirective } from './spoiler-reveal.directive';

/** A container whose HTML holds a spoiler span (as the sanitizer would emit it). */
function container(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

/** A minimal event whose target is `el`, recording preventDefault/stopPropagation. */
function eventOn(el: Element) {
  return {
    target: el,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as Event;
}

describe('SpoilerRevealDirective', () => {
  const directive = new SpoilerRevealDirective();

  it('reveals a spoiler on click and swallows that activating event', () => {
    const root = container('<span class="mx-spoiler">secret</span>');
    const spoiler = root.querySelector('.mx-spoiler')!;
    const event = eventOn(spoiler);

    directive.onClick(event);

    expect(spoiler.classList.contains('is-revealed')).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it('reveals when a child of the spoiler is clicked (e.g. a link inside)', () => {
    const root = container(
      '<span class="mx-spoiler"><a href="https://x">link</a></span>',
    );
    const link = root.querySelector('a')!;
    const spoiler = root.querySelector('.mx-spoiler')!;

    directive.onClick(eventOn(link));

    expect(spoiler.classList.contains('is-revealed')).toBe(true);
  });

  it('lets a click on an already-revealed spoiler proceed (link works)', () => {
    const root = container('<span class="mx-spoiler is-revealed">x</span>');
    const spoiler = root.querySelector('.mx-spoiler')!;
    const event = eventOn(spoiler);

    directive.onClick(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('ignores a click outside any spoiler', () => {
    const root = container('<span>plain</span>');
    const span = root.querySelector('span')!;
    const event = eventOn(span);

    directive.onClick(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('reveals on a keyboard activation of the focused spoiler', () => {
    const root = container('<span class="mx-spoiler">secret</span>');
    const spoiler = root.querySelector('.mx-spoiler')!;
    const event = eventOn(spoiler);

    directive.onKey(event);

    expect(spoiler.classList.contains('is-revealed')).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
  });
});
