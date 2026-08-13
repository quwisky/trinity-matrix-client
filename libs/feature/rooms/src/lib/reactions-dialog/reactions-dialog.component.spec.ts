import { DialogRef } from '@trinity/helm/overlay';
import { TimelineService } from '@trinity/data-access/timeline';
import { AvatarComponent } from '@trinity/ui';
import { type ReactionDetail } from '@trinity/util/matrix';
import { render } from '@trinity/testing';
import { MockComponent, MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { ReactionsDialogComponent } from './reactions-dialog.component';

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

  async function build() {
    const { fixture, container } = await render(ReactionsDialogComponent, {
      inputs: { eventId: '$m' },
      imports: [MockComponent(AvatarComponent)],
      providers: [
        MockProvider(DialogRef, { close: vi.fn() }),
        MockProvider(TimelineService, { reactionDetails }),
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
});
