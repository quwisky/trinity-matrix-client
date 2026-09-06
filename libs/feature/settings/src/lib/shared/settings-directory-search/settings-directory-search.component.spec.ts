import { fireEvent, screen } from '@testing-library/angular';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { SettingsDirectorySearchComponent } from './settings-directory-search.component';

describe('Settings directory search', () => {
  it('offers an accessible search field and returns focus there after clearing', async () => {
    const { fixture } = await render(SettingsDirectorySearchComponent);
    const search = screen.getByRole('searchbox', { name: 'Search settings' });
    fireEvent.input(search, { target: { value: 'appearance' } });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Clear search' }),
    );
    await fixture.whenStable();
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
  });
});
