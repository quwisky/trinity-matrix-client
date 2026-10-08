import { provideTrnIcons } from '@trinity/components/foundations';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import {
  SidebarSpaceHeaderComponent,
  type SidebarSpaceAction,
} from './sidebar-space-header.component';

async function renderHeader(inputs: Record<string, unknown> = {}) {
  const rendered = await render(SidebarSpaceHeaderComponent, {
    inputs: { spaceName: 'Trinity', ...inputs },
    providers: [provideTrnIcons()],
  });
  const actions: SidebarSpaceAction[] = [];
  rendered.fixture.componentInstance.spaceAction.subscribe((a) =>
    actions.push(a),
  );
  const click = (selector: string, root: ParentNode = rendered.container) => {
    root.querySelector<HTMLElement>(selector)!.click();
    rendered.fixture.detectChanges();
  };
  return { ...rendered, actions, click };
}

describe('SidebarSpaceHeaderComponent', () => {
  it('shows the plain title with Home actions outside a space', async () => {
    const { container, actions, click } = await renderHeader({
      hasAnyUnread: true,
    });

    expect(
      container.querySelector('span.sidebar__title')?.textContent,
    ).toContain('Trinity');
    expect(container.querySelector('[data-testid="space-header"]')).toBeNull();
    click('[data-testid="mark-all-read"]');
    click('[data-testid="open-switcher"]');
    click('[aria-label="New room or direct message"]');

    expect(actions.map((a) => a.kind)).toEqual([
      'mark-all-read',
      'open-switcher',
      'new-chat',
    ]);
    expect(actions[2]).toMatchObject({
      anchor: container.querySelector(
        '[aria-label="New room or direct message"]',
      ),
    });
  });

  it('hides the switcher when the title row owns it', async () => {
    const { container } = await renderHeader({ showSwitcher: false });

    expect(container.querySelector('[data-testid="open-switcher"]')).toBeNull();
  });

  it('opens the space menu from the title and emits its actions', async () => {
    const { container, actions, click } = await renderHeader({
      spaceActive: true,
      hasAnyUnread: true,
      canInviteToSpace: true,
      canCurateSpace: true,
    });

    click('[aria-label="Create a room"]');
    click('[data-testid="space-header"]');
    click('[data-testid="mark-all-read"]', document);
    click('[data-testid="space-header"]');
    click('[data-testid="space-invite"]', document);
    click('[data-testid="space-header"]');
    click('[data-testid="space-leave"]', document);

    expect(
      container.querySelector('[data-testid="open-space-settings"]'),
    ).toBeNull();
    expect(actions.map((a) => a.kind)).toEqual([
      'create-room',
      'mark-all-read',
      'invite',
      'leave',
    ]);
  });

  it('offers space settings only to a configurer', async () => {
    const { click } = await renderHeader({
      spaceActive: true,
      canConfigureSpace: true,
    });

    click('[data-testid="space-header"]');

    expect(
      document.querySelector('[data-testid="open-space-settings"]'),
    ).not.toBeNull();
  });

  it('emits the chosen ordering, and null for the account default', async () => {
    const { actions, click } = await renderHeader({ spaceActive: true });

    click('[data-testid="space-header"]');
    click('[data-testid="space-sort"]', document);
    click('[data-testid="space-sort-alphabetical"]', document);
    click('[data-testid="space-header"]');
    click('[data-testid="space-sort"]', document);
    click('[data-testid="space-sort-default"]', document);

    expect(actions).toEqual([
      { kind: 'sort', mode: 'alphabetical' },
      { kind: 'sort', mode: null },
    ]);
  });
});
