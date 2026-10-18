import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { UnencryptedMarkComponent } from './unencrypted-mark.component';

describe('UnencryptedMarkComponent', () => {
  it('names the mark and explains it, in red for a message sent after encryption', async () => {
    const { container } = await render(UnencryptedMarkComponent, {
      inputs: {
        shield: {
          level: 'unencrypted',
          reason: 'Not encrypted',
          explanation: 'This message was sent without end-to-end encryption.',
        },
      },
    });

    const icon = container.querySelector('trn-icon');
    expect(icon?.getAttribute('aria-label')).toBe('Not encrypted');
    expect(icon?.getAttribute('title')).toBe(
      'This message was sent without end-to-end encryption.',
    );
    expect(icon?.classList).toContain('text-danger');
  });

  it('draws the quieter open lock for a message dated before encryption', async () => {
    const { container } = await render(UnencryptedMarkComponent, {
      inputs: {
        shield: {
          level: 'unencrypted-history',
          reason: 'Not encrypted',
          explanation:
            'This message is dated before the room turned on end-to-end encryption.',
        },
      },
    });

    const icon = container.querySelector('trn-icon');
    expect(icon?.getAttribute('data-testid')).toBe(
      'unencrypted-mark-unencrypted-history',
    );
    expect(icon?.classList).toContain('text-muted-foreground');
  });
});
