import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { TrnEmojiSuggestion } from '@trinity/components/emoji-picker';
import { render } from '@trinity/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { ComposerSuggestionsComponent } from './composer-suggestions.component';
import { type MentionMember } from '../mention-autocomplete';

/**
 * Both menus render in the CDK overlay container, so every lookup here is against `document`
 * rather than the fixture. That is the one thing this move changes for a consumer's spec, and
 * it changes it for every one of them.
 */
const overlay = {
  querySelector: <T extends Element>(selector: string) =>
    document.querySelector<T>(selector),
  querySelectorAll: (selector: string) => document.querySelectorAll(selector),
};

/**
 * A host, because the menus now need something to anchor to.
 *
 * Rendering the component bare used to be enough; an anchored layer with nowhere to anchor
 * renders nothing at all, which is the overlay behaving correctly and this spec needing a
 * scrap of layout it did not before.
 */
@Component({
  imports: [ComposerSuggestionsComponent],
  template: `
    <div #anchor></div>
    <trn-composer-suggestions
      [anchor]="anchor"
      [emojiOpen]="emojiOpen()"
      [emojiMatches]="emojiMatches()"
      [emojiActiveIndex]="emojiActiveIndex()"
      [mentionOpen]="mentionOpen()"
      [mentionMatches]="mentionMatches()"
      [mentionActiveIndex]="mentionActiveIndex()"
      (emojiHighlight)="events.push(['emojiHighlight', $event])"
      (emojiAccept)="events.push(['emojiAccept', $event])"
      (mentionHighlight)="events.push(['mentionHighlight', $event])"
      (mentionAccept)="events.push(['mentionAccept', $event])"
    />
  `,
})
class HostComponent {
  readonly emojiOpen = signal(false);
  readonly emojiMatches = signal<readonly TrnEmojiSuggestion[]>([]);
  readonly emojiActiveIndex = signal(0);
  readonly mentionOpen = signal(false);
  readonly mentionMatches = signal<readonly MentionMember[]>([]);
  readonly mentionActiveIndex = signal(0);
  readonly events: [string, number][] = [];
}

/** Render with the given state, then let the overlay attach. */
async function build(
  state: Partial<
    Record<
      | 'emojiOpen'
      | 'emojiMatches'
      | 'emojiActiveIndex'
      | 'mentionOpen'
      | 'mentionMatches'
      | 'mentionActiveIndex',
      unknown
    >
  > = {},
) {
  const { fixture } = await render(HostComponent);
  const host = fixture.componentInstance;
  for (const [key, value] of Object.entries(state)) {
    (host[key as keyof HostComponent] as { set: (v: unknown) => void }).set(
      value,
    );
  }
  TestBed.tick();
  return { host };
}

/** Only the four fields the menu reads; the real objects carry emoji-mart's whole record. */
const emoji = (id: string, native: string) =>
  ({ id, native, colons: `:${id}:` }) satisfies TrnEmojiSuggestion;

const members: MentionMember[] = [
  { userId: '@ada:x', name: 'Ada' },
  { userId: '@bob:x', name: 'Bob' },
];

describe('ComposerSuggestionsComponent', () => {
  it('renders neither menu while both are closed', async () => {
    await build();

    expect(
      overlay.querySelector('[data-testid=emoji-autocomplete]'),
    ).toBeNull();
    expect(
      overlay.querySelector('[data-testid=mention-autocomplete]'),
    ).toBeNull();
  });

  it('offers the emoji suggestions as a labelled listbox of options', async () => {
    await build({
      emojiOpen: true,
      emojiMatches: [emoji('smile', '😄'), emoji('smirk', '😏')],
    });

    const menu = overlay.querySelector('[data-testid=emoji-autocomplete]');
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
    await build({
      emojiOpen: true,
      emojiMatches: [emoji('smile', '😄'), emoji('smirk', '😏')],
      mentionOpen: true,
      mentionMatches: members,
    });

    expect(overlay.querySelector('#emoji-suggestions')).not.toBeNull();
    expect(overlay.querySelector('#mention-suggestions')).not.toBeNull();
    expect(overlay.querySelector('#emoji-suggestion-1')).not.toBeNull();
    expect(overlay.querySelector('#mention-suggestion-1')).not.toBeNull();
  });

  it('marks only the highlighted option as selected', async () => {
    await build({
      mentionOpen: true,
      mentionMatches: members,
      mentionActiveIndex: 1,
    });

    const options = overlay.querySelectorAll('[role=option]');
    expect(options[0].getAttribute('aria-selected')).toBe('false');
    expect(options[1].getAttribute('aria-selected')).toBe('true');
    expect(
      options[1].classList.contains('composer__emoji-suggestion--active'),
    ).toBe(true);
  });

  it('reports a hovered or clicked emoji suggestion by index', async () => {
    const { host } = await build({
      emojiOpen: true,
      emojiMatches: [emoji('smile', '😄'), emoji('smirk', '😏')],
    });
    const second = overlay.querySelector<HTMLElement>('#emoji-suggestion-1');
    second?.dispatchEvent(new MouseEvent('mouseenter'));
    second?.click();

    expect(host.events).toEqual([
      ['emojiHighlight', 1],
      ['emojiAccept', 1],
    ]);
  });

  it('reports a hovered or clicked member suggestion by index', async () => {
    const { host } = await build({
      mentionOpen: true,
      mentionMatches: members,
    });
    const first = overlay.querySelector<HTMLElement>('#mention-suggestion-0');
    first?.dispatchEvent(new MouseEvent('mouseenter'));
    first?.click();

    expect(host.events).toEqual([
      ['mentionHighlight', 0],
      ['mentionAccept', 0],
    ]);
  });

  it('cancels the mousedown so clicking a suggestion never blurs the textarea', async () => {
    // A blur closes the menu, which would delete the option mid-click.
    await build({ mentionOpen: true, mentionMatches: members });

    const event = new MouseEvent('mousedown', { cancelable: true });
    overlay.querySelector('#mention-suggestion-0')?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  afterEach(() => TestBed.resetTestingModule());
});
