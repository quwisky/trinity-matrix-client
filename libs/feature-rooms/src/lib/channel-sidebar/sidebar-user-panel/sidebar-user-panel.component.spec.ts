import { render } from '@trinity/testing';
import { SidebarUserPanelComponent } from './sidebar-user-panel.component';

// The account-switcher dropdown (switch / add / sign out / re-auth rows) is
// exercised end-to-end through the parent in channel-sidebar.component.spec.ts;
// here we cover the always-visible footer trigger this component owns.
const USER = { userId: '@alice:hs', displayName: 'Alice', avatarMxc: null };

describe('SidebarUserPanelComponent', () => {
  it('shows the signed-in user name and handle in the trigger', async () => {
    const { container } = await render(SidebarUserPanelComponent, {
      inputs: { user: USER },
    });

    expect(container.querySelector('.userbar__name')?.textContent).toContain(
      'Alice',
    );
    expect(container.querySelector('.userbar__handle')?.textContent).toContain(
      '@alice:hs',
    );
  });

  it('emits openSettings when the settings button is clicked', async () => {
    const { fixture, container } = await render(SidebarUserPanelComponent, {
      inputs: { user: USER },
    });

    let opened = false;
    fixture.componentInstance.openSettings.subscribe(() => (opened = true));
    container.querySelector<HTMLElement>('.userbar__settings')!.click();

    expect(opened).toBe(true);
  });
});
