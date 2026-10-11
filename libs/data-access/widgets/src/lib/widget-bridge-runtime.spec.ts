import {
  OpenIDRequestState,
  SimpleObservable,
  type Capability,
} from 'matrix-widget-api';
import { describe, expect, it, vi } from 'vitest';
import { RestrictedWidgetDriver } from './widget-bridge-runtime';

describe('RestrictedWidgetDriver', () => {
  it('approves no requested capabilities', async () => {
    const requested = new Set<Capability>([
      'm.always_on_screen',
      'org.matrix.msc2762.timeline:*',
    ]);

    expect(
      await new RestrictedWidgetDriver().validateCapabilities(requested),
    ).toEqual(new Set());
  });

  it('blocks OpenID requests', () => {
    const updates = vi.fn();
    const observer = new SimpleObservable(updates);

    new RestrictedWidgetDriver().askOpenID(observer);

    expect(updates).toHaveBeenCalledWith({ state: OpenIDRequestState.Blocked });
  });
});
