import { render } from '@trinity/testing';
import { screen } from '@testing-library/angular';
import { describe, expect, it } from 'vitest';
import { TimelineSkeletonComponent } from './timeline-skeleton.component';

describe('TimelineSkeletonComponent', () => {
  it('announces loading once and hides the placeholder shapes from assistive tech', async () => {
    const { container } = await render(TimelineSkeletonComponent);
    expect(screen.getByRole('status').textContent?.trim()).toBe(
      'Loading messages…',
    );
    const groups = container.querySelectorAll('.skeleton-group');
    expect(groups).toHaveLength(3);
    for (const group of groups) {
      expect(group.getAttribute('aria-hidden')).toBe('true');
      expect(group.querySelector('.skeleton-avatar')).not.toBeNull();
      expect(group.querySelector('.skeleton-bar--name')).not.toBeNull();
    }
    expect(
      container.querySelector('[data-testid="timeline-skeleton"]'),
    ).not.toBeNull();
  });
});
