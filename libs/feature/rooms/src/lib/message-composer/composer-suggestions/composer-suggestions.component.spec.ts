import { TestBed } from '@angular/core/testing';
import type { EmojiData } from '@ctrl/ngx-emoji-mart/ngx-emoji';
import { render } from '@trinity/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { ComposerSuggestionsComponent } from './composer-suggestions.component';
import { type MentionMember } from '../mention-autocomplete';

/** Only the four fields the menu reads; the real objects carry emoji-mart's whole record. */
const emoji = (id: string, native: string) =>
  ({ id, native, colons: `:${id}:` }) as EmojiData;

const members: MentionMember[] = [
  { userId: '@ada:x', name: 'Ada' },
  { userId: '@bob:x', name: 'Bob' },
];

describe('ComposerSuggestionsComponent', () => {
  it('renders neither menu while both are closed', async () => {
    const { container } = await render(ComposerSuggestionsComponent, {
      inputs: {},
    });

    expect(
      container.querySelector('[data-testid=emoji-autocomplete]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid=mention-autocomplete]'),
    ).toBeNull();
  });

  it('offers the emoji suggestions as a labelled listbox of options', async () => {
    const { container } = await render(ComposerSuggestionsComponent, {
      inputs: {
        emojiOpen: true,
        emojiMatches: [emoji('smile', '😄'), emoji('smirk', '😏')],
      },
    });

    const menu = container.querySelector('[data-testid=emoji-autocomplete]');
    expect(menu?.getAttribute('role')).toBe('listbox');
    expect(menu?.getAttribute('aria-label')).toBe('Emoji suggestions');
    const options = menu?.querySelectorAll('[role=option]') ?? [];
    expect(options.length).toBe(2);
    expect(options[0].textContent).toContain('😄');
    expect(options[0].textContent).toContain(':smile:');
  });

  it('stamps the ids the composer textarea points aria-activedescendant at', async () => {
    // The id is the contract between this listbox, the textarea's aria-activedescendant and
    // the composer's scrollSuggestionIntoView — renaming one means renaming all three.
    const { container } = await render(ComposerSuggestionsComponent, {
      inputs: {
        emojiOpen: true,
        emojiMatches: [emoji('smile', '😄'), emoji('smirk', '😏')],
        mentionOpen: true,
        mentionMatches: members,
      },
    });

    expect(container.querySelector('#emoji-suggestions')).not.toBeNull();
    expect(container.querySelector('#mention-suggestions')).not.toBeNull();
    expect(container.querySelector('#emoji-suggestion-1')).not.toBeNull();
    expect(container.querySelector('#mention-suggestion-1')).not.toBeNull();
  });

  it('marks only the highlighted option as selected', async () => {
    const { container } = await render(ComposerSuggestionsComponent, {
      inputs: {
        mentionOpen: true,
        mentionMatches: members,
        mentionActiveIndex: 1,
      },
    });

    const options = container.querySelectorAll('[role=option]');
    expect(options[0].getAttribute('aria-selected')).toBe('false');
    expect(options[1].getAttribute('aria-selected')).toBe('true');
    expect(
      options[1].classList.contains('composer__emoji-suggestion--active'),
    ).toBe(true);
  });

  it('reports a hovered or clicked emoji suggestion by index', async () => {
    const { fixture, container } = await render(ComposerSuggestionsComponent, {
      inputs: {
        emojiOpen: true,
        emojiMatches: [emoji('smile', '😄'), emoji('smirk', '😏')],
      },
    });
    const highlighted: number[] = [];
    const accepted: number[] = [];
    fixture.componentInstance.emojiHighlight.subscribe((i) =>
      highlighted.push(i),
    );
    fixture.componentInstance.emojiAccept.subscribe((i) => accepted.push(i));

    const second = container.querySelector<HTMLElement>('#emoji-suggestion-1');
    second?.dispatchEvent(new MouseEvent('mouseenter'));
    second?.click();

    expect(highlighted).toEqual([1]);
    expect(accepted).toEqual([1]);
  });

  it('reports a hovered or clicked member suggestion by index', async () => {
    const { fixture, container } = await render(ComposerSuggestionsComponent, {
      inputs: { mentionOpen: true, mentionMatches: members },
    });
    const highlighted: number[] = [];
    const accepted: number[] = [];
    fixture.componentInstance.mentionHighlight.subscribe((i) =>
      highlighted.push(i),
    );
    fixture.componentInstance.mentionAccept.subscribe((i) => accepted.push(i));

    const first = container.querySelector<HTMLElement>('#mention-suggestion-0');
    first?.dispatchEvent(new MouseEvent('mouseenter'));
    first?.click();

    expect(highlighted).toEqual([0]);
    expect(accepted).toEqual([0]);
  });

  it('cancels the mousedown so clicking a suggestion never blurs the textarea', async () => {
    // A blur closes the menu, which would delete the option mid-click.
    const { container } = await render(ComposerSuggestionsComponent, {
      inputs: { mentionOpen: true, mentionMatches: members },
    });

    const event = new MouseEvent('mousedown', { cancelable: true });
    container.querySelector('#mention-suggestion-0')?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  afterEach(() => TestBed.resetTestingModule());
});
