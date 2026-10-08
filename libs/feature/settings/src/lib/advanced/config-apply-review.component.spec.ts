import { render } from '@trinity/testing';
import { describe, expect, it, vi } from 'vitest';
import { ConfigApplyReviewComponent } from './config-apply-review.component';

const idle = {
  problems: [] as readonly string[],
  warnings: [] as readonly string[],
  changeLines: [] as readonly string[],
  nothingToChange: false,
  applying: false,
};

const byId = (container: Element, id: string) =>
  container.querySelector(`[data-testid=${id}]`);

describe('ConfigApplyReviewComponent', () => {
  it('renders nothing while there is nothing to report', async () => {
    const { container } = await render(ConfigApplyReviewComponent, {
      inputs: idle,
    });

    expect(container.querySelector('[data-testid^=advanced-apply]')).toBeNull();
  });

  it('lists the problems as an alert', async () => {
    const { container } = await render(ConfigApplyReviewComponent, {
      inputs: { ...idle, problems: ['theme.palette is not text'] },
    });

    const alert = byId(container, 'advanced-apply-problems');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('theme.palette is not text');
  });

  it('lists the warnings and says there is nothing to change', async () => {
    const { container } = await render(ConfigApplyReviewComponent, {
      inputs: { ...idle, warnings: ['desktop only'], nothingToChange: true },
    });

    expect(byId(container, 'advanced-apply-warnings')?.textContent).toContain(
      'desktop only',
    );
    expect(byId(container, 'advanced-apply-nothing')).not.toBeNull();
  });

  it('pluralises the confirm button and emits confirm and cancel', async () => {
    const confirmed = vi.fn();
    const cancelled = vi.fn();
    const { container } = await render(ConfigApplyReviewComponent, {
      inputs: { ...idle, changeLines: ['a', 'b'] },
      on: { confirmed, cancelled },
    });

    const ok = byId(container, 'advanced-apply-confirm') as HTMLButtonElement;
    expect(ok.textContent?.replace(/\s+/g, ' ').trim()).toBe('Apply 2 changes');
    ok.click();
    (byId(container, 'advanced-apply-cancel') as HTMLButtonElement).click();

    expect(confirmed).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('disables both buttons while applying', async () => {
    const { container } = await render(ConfigApplyReviewComponent, {
      inputs: { ...idle, changeLines: ['a'], applying: true },
    });

    expect(
      (byId(container, 'advanced-apply-confirm') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (byId(container, 'advanced-apply-cancel') as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
