import { inject } from '@angular/core';
import { TrnDialogRef } from '@trinity/components/overlay';
import {
  ConversationRuntime,
  type ReactionDetail,
} from '@trinity/data-access/timeline';
import { AvatarComponent } from '@trinity/components/generic-content';
import { render } from '@trinity/testing';
import { MockComponent, MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { ReactionsDialogComponent } from './reactions-dialog.component';
import { ConversationTimelineStub } from '../testing/conversation-timeline.stub';

function reactor(name: string) {
  return {
    userId: `@${name.toLowerCase()}:hs`,
    name,
    initial: name[0],
    avatarMxc: null,
  };
}

const SECTIONS: ReactionDetail[] = [
  { key: '👍', reacted: true, reactors: [reactor('Alice'), reactor('Bob')] },
  { key: '🎉', reacted: false, reactors: [reactor('Carol')] },
];

describe('ReactionsDialogComponent', () => {
  let reactionDetails: Mock;

  beforeEach(() => {
    reactionDetails = vi.fn(() => SECTIONS);
  });

  async function build(options: { sheet?: boolean } = {}) {
    const { fixture, container } = await render(ReactionsDialogComponent, {
      inputs: { eventId: '$m', sheet: options.sheet ?? false },
      imports: [MockComponent(AvatarComponent)],
      providers: [
        MockProvider(TrnDialogRef, { close: vi.fn() }),
        MockProvider(ConversationTimelineStub, { reactionDetails }),
        {
          provide: ConversationRuntime,
          useFactory: () => ({ timeline: inject(ConversationTimelineStub) }),
        },
      ],
    });
    return { fixture, container, c: fixture.componentInstance };
  }

  function names(container: HTMLElement): string[] {
    return [...container.querySelectorAll('.reactor__name')].map((el) =>
      el.textContent?.trim(),
    ) as string[];
  }

  it('lists the reactors of the first key, with a chip per key', async () => {
    const { container } = await build();

    expect(reactionDetails).toHaveBeenCalledWith('$m');
    expect(container.querySelectorAll('.key').length).toBe(2);
    expect(names(container)).toEqual(['Alice', 'Bob']);
    expect(
      container.querySelector('.reactions-dialog__total')?.textContent,
    ).toContain('3 total');
    expect(
      container
        .querySelector('[data-testid=close-reactions]')
        ?.getAttribute('aria-label'),
    ).toBe('Close Reactions');
  });

  it('switches sections when another key is picked', async () => {
    const { fixture, container } = await build();

    container.querySelectorAll<HTMLButtonElement>('.key')[1].click();
    fixture.detectChanges();

    expect(names(container)).toEqual(['Carol']);
  });

  it('says so when there is nothing to show', async () => {
    reactionDetails.mockReturnValue([]);
    const { container } = await build();

    expect(
      container.querySelector('[data-testid=reactions-empty]'),
    ).toBeTruthy();
    expect(container.querySelector('[data-testid=reactors-list]')).toBeNull();
  });

  it('keeps the selected reaction identifiable', async () => {
    const { fixture, container } = await build();

    const second = container.querySelectorAll<HTMLButtonElement>('.key')[1];
    expect(second.getAttribute('aria-pressed')).toBe('false');
    second.click();
    fixture.detectChanges();

    expect(second.getAttribute('aria-pressed')).toBe('true');
    expect(
      container.querySelector('.reactions-dialog__detail h3')?.textContent,
    ).toContain('🎉');
  });

  it('uses the sheet surface input without changing the snapshot selection', async () => {
    const { fixture, container, c } = await build({ sheet: true });

    expect(container.querySelector('[data-trn-layout="sheet"]')).toBeTruthy();
    expect(container.querySelector('[data-trn-layout="dialog"]')).toBeNull();
    const surface = container.querySelector<HTMLElement>(
      '[data-trn-layout="sheet"]',
    );
    expect(surface?.classList.contains('w-full')).toBe(true);
    expect(surface?.classList.contains('max-w-full')).toBe(true);
    c.select('🎉');
    fixture.detectChanges();

    expect(c.selected()?.key).toBe('🎉');
    expect(
      fixture.nativeElement.classList.contains('reactions-dialog--sheet'),
    ).toBe(true);
  });
});
