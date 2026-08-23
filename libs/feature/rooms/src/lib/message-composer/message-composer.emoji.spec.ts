import {
  enter,
  menu,
  renderComposer,
  stubObjectUrls,
  type,
} from './message-composer.spec-harness';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('MessageComposerComponent — the :shortcode autocomplete', () => {
  beforeEach(() => stubObjectUrls());

  it('opens the emoji menu while typing a :shortcode and ranks an exact match first', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    type(fixture, ':joy');

    expect(cmp.menus.emojiQuery()).toBe('joy');
    expect(menu(fixture)).not.toBeNull();
    expect(cmp.menus.emojiMatches()[0].native).toBe('😂');
  });

  it('accepts the highlighted emoji on Enter without sending the message', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    let sent = 0;
    cmp.submitText.subscribe(() => sent++);

    type(fixture, ':joy');
    cmp.onEnter(enter());

    expect(cmp.text()).toBe('😂');
    expect(sent).toBe(0);
    expect(cmp.menus.emojiOpen()).toBe(false);
  });

  it('replaces only the :shortcode token, preserving surrounding text', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    type(fixture, 'hi :joy');
    cmp.onEnter(enter());

    expect(cmp.text()).toBe('hi 😂');
  });

  it('moves the highlight with the arrow keys before accepting', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    type(fixture, ':joy');
    const second = cmp.menus.emojiMatches()[1].native;
    cmp.onArrowDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(cmp.menus.emojiActiveIndex()).toBe(1);
    cmp.onEnter(enter());

    expect(cmp.text()).toBe(second);
  });

  it('closes the menu on Escape without cancelling an active reply', async () => {
    const { fixture } = await renderComposer({ replyingTo: 'Alice' });
    const cmp = fixture.componentInstance;

    let cancelled = 0;
    cmp.cancelReply.subscribe(() => cancelled++);

    type(fixture, ':joy');
    cmp.onEscape();
    expect(cmp.menus.emojiOpen()).toBe(false);
    expect(cancelled).toBe(0);

    cmp.onEscape(); // menu already closed → now cancels the reply
    expect(cancelled).toBe(1);
  });

  it('converts a fully typed :shortcode: to its emoji inline', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    type(fixture, 'party :tada:');

    expect(cmp.text()).toBe('party 🎉');
    expect(cmp.menus.emojiOpen()).toBe(false);
  });

  it('inserts the emoji when a suggestion is clicked', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    type(fixture, ':fire');
    const option = menu(fixture)!.querySelector('button') as HTMLButtonElement;
    option.click();

    expect(cmp.text()).toBe('🔥');
    expect(cmp.menus.emojiOpen()).toBe(false);
  });

  it('does not trigger on a colon that is not a shortcode boundary', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    type(fixture, '8:30');
    expect(cmp.menus.emojiOpen()).toBe(false);
    expect(menu(fixture)).toBeNull();

    type(fixture, 'http://');
    expect(cmp.menus.emojiOpen()).toBe(false);
  });

  it('accepts on Tab when open and leaves Tab alone when closed', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    type(fixture, ':joy');
    const open = new KeyboardEvent('keydown', { key: 'Tab' });
    const openPrevent = vi.spyOn(open, 'preventDefault');
    cmp.onTab(open);

    expect(cmp.text()).toBe('😂');
    expect(cmp.menus.emojiOpen()).toBe(false);
    expect(openPrevent).toHaveBeenCalled();

    // Menu closed → Tab must keep its native focus-moving behaviour.
    const closed = new KeyboardEvent('keydown', { key: 'Tab' });
    const closedPrevent = vi.spyOn(closed, 'preventDefault');
    cmp.onTab(closed);
    expect(closedPrevent).not.toHaveBeenCalled();
  });

  it('replaces a :shortcode in the middle of the text (caret not at end)', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    type(fixture, 'hey :joy there', 8); // caret right after ":joy"
    cmp.onEnter(enter());

    expect(cmp.text()).toBe('hey 😂 there');
  });

  it('resets the highlight to the first item when the result set changes', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    type(fixture, ':joy');
    cmp.onArrowDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(cmp.menus.emojiActiveIndex()).toBe(1);

    type(fixture, ':grin'); // different matches → effect resets the index
    expect(cmp.menus.emojiMatches().length).toBeGreaterThan(1);
    expect(cmp.menus.emojiActiveIndex()).toBe(0);
  });

  it('does not open the menu while an IME composition is in progress', async () => {
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;

    ta.value = ':joy';
    ta.selectionStart = ta.selectionEnd = 4;
    const composing = new Event('input', { bubbles: true });
    Object.defineProperty(composing, 'isComposing', { value: true });
    ta.dispatchEvent(composing);
    fixture.detectChanges();

    expect(cmp.menus.emojiOpen()).toBe(false);

    // Once composition ends, the next (non-composing) input opens it.
    type(fixture, ':joy');
    expect(cmp.menus.emojiOpen()).toBe(true);
  });

  it('lets an IME-confirming Enter pass through without accepting or sending', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    let sent = 0;
    cmp.submitText.subscribe(() => sent++);

    type(fixture, ':joy');
    const composingEnter = new KeyboardEvent('keydown', { key: 'Enter' });
    Object.defineProperty(composingEnter, 'isComposing', { value: true });
    cmp.onEnter(composingEnter);

    expect(cmp.text()).toBe(':joy'); // not accepted
    expect(sent).toBe(0); // not sent
    expect(cmp.menus.emojiOpen()).toBe(true); // menu still open

    cmp.onEnter(enter()); // a real Enter then accepts
    expect(cmp.text()).toBe('😂');
  });

  it('resolves the +1/-1 shortcodes through the emoji index', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    type(fixture, ':+1');
    expect(cmp.menus.emojiMatches()[0].native).toBe('👍');
    cmp.onEnter(enter());
    expect(cmp.text()).toBe('👍');
  });

  it('renders each suggestion with its native emoji and :colons: label', async () => {
    const { fixture } = await renderComposer();

    type(fixture, ':joy');
    const first = menu(fixture)!.querySelector('.composer__emoji-suggestion')!;
    expect(
      first.querySelector('.composer__emoji-suggestion-char')?.textContent,
    ).toContain('😂');
    expect(
      first.querySelector('.composer__emoji-suggestion-code')?.textContent,
    ).toContain(':joy:');
  });

  it('does not inline-convert a token that is not a real shortcode', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;

    // "happy" is only a search keyword, never a shortcode → stays literal.
    type(fixture, 'x :happy:');
    expect(cmp.text()).toBe('x :happy:');
  });
});
