import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  type MatrixLinkClick,
  MatrixLinkDirective,
} from './matrix-link.directive';

/** A fresh directive (output() needs an injection context) plus its emitted targets. */
function setup() {
  const directive = TestBed.runInInjectionContext(
    () => new MatrixLinkDirective(),
  );
  const emitted: MatrixLinkClick[] = [];
  directive.matrixLink.subscribe((t) => emitted.push(t));
  return { directive, emitted };
}

/** Build a container from HTML and return the element matching `selector`. */
function nodeIn(html: string, selector: string): Element {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root.querySelector(selector)!;
}

/** A minimal click event whose target is `el`, recording preventDefault. */
function clickOn(el: Element) {
  return { target: el, preventDefault: vi.fn() } as unknown as Event;
}

describe('MatrixLinkDirective', () => {
  it('routes a matrix.to link in-app and swallows the click', () => {
    const { directive, emitted } = setup();
    const anchor = nodeIn(
      '<a href="https://matrix.to/#/!room:hs">room</a>',
      'a',
    );
    const event = clickOn(anchor);

    directive.onClick(event);

    expect(emitted[0]).toEqual({
      target: { kind: 'room', roomIdOrAlias: '!room:hs' },
      // The clicked element travels with the target, so a user card can be pinned to it.
      anchor,
    });
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('routes a matrix URI in-app with its federation hints', () => {
    const { directive, emitted } = setup();
    const anchor = nodeIn(
      '<a href="matrix:roomid/room:hs?via=remote.example">room</a>',
      'a',
    );
    const event = clickOn(anchor);

    directive.onClick(event);

    expect(emitted[0]?.target).toEqual({
      kind: 'room',
      roomIdOrAlias: '!room:hs',
      via: ['remote.example'],
    });
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('swallows a malformed Matrix link and reports it as invalid', () => {
    const { directive, emitted } = setup();
    const anchor = nodeIn('<a href="matrix:unknown/x">bad</a>', 'a');
    const event = clickOn(anchor);

    directive.onClick(event);

    expect(emitted[0]?.target).toEqual({ kind: 'invalid' });
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('opens an external link in a new tab instead of navigating away', () => {
    const { directive, emitted } = setup();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const anchor = nodeIn('<a href="https://example.com/x">ext</a>', 'a');
    const event = clickOn(anchor);

    directive.onClick(event);

    expect(emitted).toHaveLength(0);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(
      'https://example.com/x',
      '_blank',
      'noopener,noreferrer',
    );
    open.mockRestore();
  });

  it('leaves a link inside a concealed spoiler to the spoiler directive', () => {
    const { directive, emitted } = setup();
    const anchor = nodeIn(
      '<span class="mx-spoiler"><a href="https://matrix.to/#/@a:hs">x</a></span>',
      'a',
    );
    const event = clickOn(anchor);

    directive.onClick(event);

    expect(emitted).toHaveLength(0);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('routes a matrix.to link inside a revealed spoiler', () => {
    const { directive, emitted } = setup();
    const anchor = nodeIn(
      '<span class="mx-spoiler is-revealed"><a href="https://matrix.to/#/@a:hs">x</a></span>',
      'a',
    );
    directive.onClick(clickOn(anchor));
    expect(emitted[0]).toEqual({
      target: { kind: 'user', userId: '@a:hs' },
      anchor,
    });
  });

  it('ignores a click that is not on a link', () => {
    const { directive, emitted } = setup();
    const span = nodeIn('<span>plain</span>', 'span');
    const event = clickOn(span);

    directive.onClick(event);

    expect(emitted).toHaveLength(0);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
