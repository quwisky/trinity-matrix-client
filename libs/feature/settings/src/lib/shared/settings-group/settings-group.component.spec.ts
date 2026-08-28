import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { SettingsGroupComponent } from './settings-group.component';

describe('SettingsGroupComponent', () => {
  it('names the group from its visible heading', async () => {
    const { container } = await render(SettingsGroupComponent, {
      inputs: {
        title: 'Layout',
        headingId: 'layout-heading',
        description: 'Choose the spacing used by the application.',
      },
    });

    const section = container.querySelector('section');
    const heading = container.querySelector('h3');

    expect(section?.getAttribute('aria-labelledby')).toBe('layout-heading');
    expect(section?.className).toContain('grid');
    expect(heading?.id).toBe('layout-heading');
    expect(section?.textContent).toContain(
      'Choose the spacing used by the application.',
    );
  });
});
