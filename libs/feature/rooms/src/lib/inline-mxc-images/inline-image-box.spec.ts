import { describe, expect, it } from 'vitest';
import {
  IMAGE_ONLY_SPOILER,
  LOADING_PLACEHOLDER,
  conceal,
  markImageOnlySpoiler,
  reserveBox,
  senderSize,
  unconceal,
} from './inline-image-box';

function image(attributes: Record<string, string>): HTMLImageElement {
  const element = document.createElement('img');
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  return element;
}

/** The reserved width's two bounds, read back from the inline `min()`. */
function bounds(width: string): {
  readonly sender: number;
  readonly ratio: [number, number];
} {
  const match =
    /^min\((\d+)px, calc\(var\(--trinity-message-image-max-height\) \* (\d+) \/ (\d+)\)\)$/.exec(
      width,
    );
  if (!match) throw new Error('unexpected reserved width');
  return {
    sender: Number(match[1]),
    ratio: [Number(match[2]), Number(match[3])],
  };
}

describe('senderSize', () => {
  it.each([
    ['1', 1],
    ['400', 400],
    ['10000', 10_000],
  ])('trusts %j', (value, size) => {
    expect(senderSize(value)).toBe(size);
  });

  it.each([
    null,
    '',
    '0',
    '10001',
    '99999',
    '400px',
    '1e3',
    '-5',
    ' 400',
    '123456',
    '4.5',
  ])('does not trust %j', (value) => {
    expect(senderSize(value)).toBeNull();
  });
});

describe('reserveBox', () => {
  it('reserves the sender’s ratio, no wider than the sender and the height cap allow', () => {
    const element = image({ width: '1200', height: '900' });

    reserveBox(element);

    expect(element.style.aspectRatio).toBe('1200 / 900');
    expect(bounds(element.style.width)).toEqual({
      sender: 1200,
      ratio: [1200, 900],
    });
    expect(element.hasAttribute('width')).toBe(false);
    expect(element.hasAttribute('height')).toBe(false);
  });

  it('keeps a very tall reserved box within the cap', () => {
    const element = image({ width: '1', height: '9999' });

    reserveBox(element);

    // With a cap of 300px, the reserved width is at most 300 × 1 / 9999, so the box the
    // aspect ratio draws is at most 300px tall; the stylesheet's max-height holds it either way.
    const { sender, ratio } = bounds(element.style.width);
    const width = Math.min(sender, (300 * ratio[0]) / ratio[1]);
    expect((width * 9999) / 1).toBeLessThanOrEqual(300);
  });

  it.each<Record<string, string>>([
    { width: '400px', height: '400' },
    { width: '400', height: '20000' },
    { width: '0', height: '400' },
    { width: '400' },
    {},
  ])('reserves nothing from %j, and drops the attributes', (attributes) => {
    const element = image(attributes);

    reserveBox(element);

    expect(element.getAttribute('style')).toBeNull();
    expect(element.hasAttribute('width')).toBe(false);
    expect(element.hasAttribute('height')).toBe(false);
  });

  it('never sets an inline max-height: the stylesheet holds the only cap', () => {
    const element = image({ width: '400', height: '900' });

    reserveBox(element);

    expect(element.style.maxHeight).toBe('');
  });
});

describe('conceal and unconceal', () => {
  it('takes an image button out of the tab order and the accessibility tree, then restores it', () => {
    const element = image({ role: 'button', tabindex: '0' });

    conceal(element);
    expect(element.getAttribute('tabindex')).toBe('-1');
    expect(element.getAttribute('aria-hidden')).toBe('true');

    unconceal(element);
    expect(element.getAttribute('tabindex')).toBe('0');
    expect(element.hasAttribute('aria-hidden')).toBe(false);
  });

  it('gives an image inside a link no tab stop of its own', () => {
    const element = image({});

    conceal(element);
    expect(element.hasAttribute('tabindex')).toBe(false);
    expect(element.getAttribute('aria-hidden')).toBe('true');

    unconceal(element);
    expect(element.hasAttribute('tabindex')).toBe(false);
    expect(element.hasAttribute('aria-hidden')).toBe(false);
  });
});

describe('LOADING_PLACEHOLDER', () => {
  it('is an inline image, never a URL that could be fetched', () => {
    expect(LOADING_PLACEHOLDER.startsWith('data:image/gif;base64,')).toBe(true);
  });
});

describe('markImageOnlySpoiler', () => {
  function body(html: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host;
  }

  it('marks the outermost concealed spoiler that has no text of its own', () => {
    const host = body(
      '<span class="mx-spoiler"><span class="mx-spoiler"> <img> </span></span>',
    );
    const [outer, inner] = host.querySelectorAll('.mx-spoiler');

    markImageOnlySpoiler(host.querySelector('img')!, host);

    expect(outer.classList.contains(IMAGE_ONLY_SPOILER)).toBe(true);
    expect(inner.classList.contains(IMAGE_ONLY_SPOILER)).toBe(false);
  });

  it('skips revealed spoilers and leaves one with text unmarked', () => {
    const host = body(
      '<span class="mx-spoiler">text <span class="mx-spoiler is-revealed"><img></span></span>',
    );

    markImageOnlySpoiler(host.querySelector('img')!, host);

    expect(host.querySelector(`.${IMAGE_ONLY_SPOILER}`)).toBeNull();
  });

  it('looks no further than the body', () => {
    const outside = document.createElement('span');
    outside.className = 'mx-spoiler';
    const host = body('<img>');
    outside.append(host);

    markImageOnlySpoiler(host.querySelector('img')!, host);

    expect(outside.classList.contains(IMAGE_ONLY_SPOILER)).toBe(false);
  });
});
