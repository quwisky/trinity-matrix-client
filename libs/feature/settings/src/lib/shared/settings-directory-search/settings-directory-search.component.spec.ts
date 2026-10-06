import { fireEvent, screen } from '@testing-library/angular';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { matchingSettingsSections } from '../../settings-sections';
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

  it('keeps the result count in a live region that is only read aloud', async () => {
    await render(SettingsDirectorySearchComponent, {
      inputs: { count: 2 },
    });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('2 sections found');
    expect(status).toHaveClass('sr-only');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('lists part results and emits the section and the part when one is picked', async () => {
    const results = matchingSettingsSections('code');
    const { fixture } = await render(SettingsDirectorySearchComponent, {
      inputs: { results, count: 1 },
    });
    const picked: unknown[] = [];
    fixture.componentInstance.resultSelected.subscribe((r) => picked.push(r));

    fireEvent.click(
      screen.getByRole('button', { name: 'Appearance: Code blocks' }),
    );

    expect(picked).toEqual([
      expect.objectContaining({
        section: expect.objectContaining({ path: 'appearance' }),
        part: expect.objectContaining({ id: 'code-blocks' }),
      }),
    ]);
  });

  it('lists no buttons for section-only results', async () => {
    await render(SettingsDirectorySearchComponent, {
      inputs: { results: matchingSettingsSections('privacy'), count: 1 },
    });
    expect(screen.queryByTestId(/^settings-search-part-/)).toBeNull();
  });
});
