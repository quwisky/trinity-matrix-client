import { render, screen } from '@trinity/testing';
import { provideTrnIcons } from '@trinity/components/foundations';
import { SidePanelHeaderComponent } from './side-panel-header.component';

describe('SidePanelHeaderComponent', () => {
  it('titles the panel and closes it', async () => {
    const closed = vi.fn();
    await render(SidePanelHeaderComponent, {
      inputs: { title: 'Members', closeTestId: 'close-members' },
      on: { closed },
      providers: [provideTrnIcons()],
    });
    expect(
      screen.getByRole('heading', { level: 2, name: 'Members' }),
    ).toBeTruthy();
    screen.getByTestId('close-members').click();
    expect(closed).toHaveBeenCalledOnce();
  });
});
