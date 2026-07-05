import { render, screen } from '@testing-library/angular';
import { AvatarComponent } from '@trinity/ui';
import { MockComponent } from 'ng-mocks';
import { describe, expect, it } from 'vitest';
import { MemberListComponent } from './member-list.component';

describe('MemberListComponent', () => {
  it('renders a row per member with the count in the header', async () => {
    const { container } = await render(MemberListComponent, {
      inputs: {
        members: [
          { userId: '@a:hs', name: 'Alice', initial: 'A', avatarMxc: null },
          { userId: '@b:hs', name: 'Bob', initial: 'B', avatarMxc: null },
        ],
      },
      imports: [MockComponent(AvatarComponent)],
    });

    const rows = container.querySelectorAll('.member');
    expect(rows.length).toBe(2);
    expect(container.querySelector('.category')?.textContent).toContain('2');
    expect(rows[0].textContent).toContain('Alice');
  });

  it('emits closed when the header close button is clicked', async () => {
    const { fixture } = await render(MemberListComponent, {
      imports: [MockComponent(AvatarComponent)],
    });

    let closed = false;
    fixture.componentInstance.closed.subscribe(() => (closed = true));
    screen.getByTestId('close-members').click();

    expect(closed).toBe(true);
  });
});
