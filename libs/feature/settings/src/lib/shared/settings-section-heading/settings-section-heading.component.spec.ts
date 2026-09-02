import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { SettingsSectionHeadingComponent } from './settings-section-heading.component';

describe('SettingsSectionHeadingComponent', () => {
  it('keeps the section name and supporting copy in one semantic intro', async () => {
    const { container } = await render(SettingsSectionHeadingComponent, {
      inputs: {
        title: 'Appearance',
        headingId: 'appearance-heading',
        description: 'Tune theme, type and spacing together.',
        primary: true,
      },
    });

    const heading = container.querySelector('h2');
    const intro = container.querySelector('header');

    expect(heading?.id).toBe('appearance-heading');
    expect(heading?.textContent?.trim()).toBe('Appearance');
    expect(intro?.textContent).toContain(
      'Tune theme, type and spacing together.',
    );
    expect(container.querySelectorAll('h2')).toHaveLength(1);
  });
});
