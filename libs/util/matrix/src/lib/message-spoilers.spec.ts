import { describe, expect, it } from 'vitest';
import { sanitizeMatrixHtml, sanitizeOutgoingHtml } from './message-view';

function spoilerIn(html: string): Element {
  const element = document.createElement('div');
  element.innerHTML = sanitizeMatrixHtml(html);
  return element.querySelector('.mx-spoiler') as Element;
}

describe('spoiler reasons', () => {
  it('copies the reason into label and names the concealed spoiler with it', () => {
    const spoiler = spoilerIn(
      '<span data-mx-spoiler="ending of the film">she lives</span>',
    );

    expect(spoiler.getAttribute('label')).toBe('ending of the film');
    expect(spoiler.getAttribute('aria-label')).toBe(
      'Spoiler: ending of the film, activate to reveal',
    );
    // Generated content only: the reason never joins the message's text.
    expect(spoiler.textContent).toBe('she lives');
  });

  it('trims the reason and collapses its whitespace to one line', () => {
    expect(
      spoilerIn(
        '<span data-mx-spoiler="  the\n\tending   now  ">x</span>',
      ).getAttribute('label'),
    ).toBe('the ending now');
  });

  it('cuts the reason to 80 characters, counting an emoji as one', () => {
    const label = spoilerIn(
      `<span data-mx-spoiler="${'😀'.repeat(100)}">x</span>`,
    ).getAttribute('label');

    expect(Array.from(label ?? '')).toHaveLength(80);
  });

  it.each([
    '<span data-mx-spoiler>x</span>',
    '<span data-mx-spoiler="   ">x</span>',
  ])('gives %s no label and a plain name', (html) => {
    const spoiler = spoilerIn(html);

    expect(spoiler.hasAttribute('label')).toBe(false);
    expect(spoiler.getAttribute('aria-label')).toBe(
      'Spoiler, activate to reveal',
    );
  });

  it('sends the sender’s attribute and none of the render markup', () => {
    const outgoing = sanitizeOutgoingHtml(
      '<span data-mx-spoiler="why">x</span>',
    );

    expect(outgoing).toContain('data-mx-spoiler="why"');
    expect(outgoing).not.toContain('label=');
  });
});
