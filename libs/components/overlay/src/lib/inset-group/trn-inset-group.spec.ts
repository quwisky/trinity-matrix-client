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
    expect(row.classList).toContain('px-4');
    expect(row.classList).toContain('py-4');
  });

  it('divider insets past the icon by default and to the edge on request', async () => {
    await render(HostComponent);

    expect(screen.getByTestId('icon-divider').classList).toContain('ms-14');
    expect(screen.getByTestId('edge-divider').classList).toContain('ms-4');
  });
});
