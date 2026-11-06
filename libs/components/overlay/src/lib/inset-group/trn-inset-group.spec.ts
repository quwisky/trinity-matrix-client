import { Component } from '@angular/core';
import { render, screen } from '@trinity/testing';
import { TrnButton } from '@trinity/components/controls';
import { describe, expect, it } from 'vitest';
import {
  TrnInsetDividerComponent,
  TrnInsetGroup,
  TrnInsetRow,
} from './trn-inset-group';

@Component({
  imports: [TrnInsetGroup, TrnInsetRow, TrnInsetDividerComponent, TrnButton],
  template: `
    <div trnInsetGroup data-testid="card">
      <button trnBtn trnInsetRow shape="row" type="button">Copy</button>
      <trn-inset-divider data-testid="icon-divider" />
      <trn-inset-divider inset="edge" data-testid="edge-divider" />
    </div>
  `,
})
class HostComponent {}

describe('inset group primitives', () => {
  it('card carries the surface fill and radius', async () => {
    await render(HostComponent);

    expect(screen.getByTestId('card').classList).toContain(
      'bg-[color:var(--trinity-neutral-fill-surface)]',
    );
    expect(screen.getByTestId('card').classList).toContain(
      'rounded-[var(--trinity-radius-xl)]',
    );
  });

  it('row stays a button with its name', async () => {
    await render(HostComponent);

    const row = screen.getByRole('button', { name: 'Copy' });
    expect(row.classList).toContain('py-4');
  });

  it('caps the row padding and gap so the largest text size leaves the label room', async () => {
    await render(HostComponent);

    const row = screen.getByRole('button', { name: 'Copy' });
    // 1rem is 16px at the default size; the cap stops the 250% root from taking 80px a side.
    expect(row.classList).toContain('px-[min(1rem,16px)]');
    expect(row.classList).toContain('gap-[min(1rem,16px)]');
  });

  it('divider insets past the icon by default and to the edge on request', async () => {
    await render(HostComponent);

    expect(screen.getByTestId('icon-divider').classList).toContain(
      'ms-[calc(min(1rem,16px)*2+1.5rem)]',
    );
    expect(screen.getByTestId('edge-divider').classList).toContain(
      'ms-[min(1rem,16px)]',
    );
  });
});
