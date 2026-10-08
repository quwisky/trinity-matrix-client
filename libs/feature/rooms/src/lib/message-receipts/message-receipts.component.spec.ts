import { render } from '@trinity/testing';
import { MessageReceiptsComponent } from './message-receipts.component';

describe('MessageReceiptsComponent', () => {
  const receipts = [
    { userId: '@a:hs', name: 'Alice', initial: 'A', avatarMxc: null },
    { userId: '@b:hs', name: 'Bob', initial: 'B', avatarMxc: null },
  ];

  it('labels the cluster with everyone who has read the message', async () => {
    const { getByTestId } = await render(MessageReceiptsComponent, {
      inputs: { receipts },
    });

    expect(getByTestId('read-receipts')).toHaveAttribute(
      'aria-label',
      'Seen by Alice, Bob',
    );
  });

  it('toggles the seen-by list from the cluster', async () => {
    const { getByTestId, queryByTestId, fixture } = await render(
      MessageReceiptsComponent,
      { inputs: { receipts } },
    );
    expect(queryByTestId('seen-by-list')).toBeNull();
    expect(getByTestId('read-receipts').getAttribute('aria-expanded')).toBe(
      'false',
    );

    getByTestId('read-receipts').click();
    fixture.detectChanges();
    expect(getByTestId('read-receipts').getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(getByTestId('seen-by-list').textContent).toContain(
      'Seen by Alice, Bob',
    );

    getByTestId('read-receipts').click();
    fixture.detectChanges();
    expect(queryByTestId('seen-by-list')).toBeNull();
  });
});
