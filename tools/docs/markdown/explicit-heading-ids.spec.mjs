import { describe, expect, it } from 'vitest';
import explicitHeadingIds from './explicit-heading-ids.mjs';

describe('explicit heading IDs', () => {
  it('moves a valid trailing marker into the rendered heading ID', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'heading',
          depth: 2,
          children: [
            { type: 'text', value: 'Set up your workspace {#set-up}' },
          ],
        },
      ],
    };

    explicitHeadingIds()(tree);

    expect(tree.children[0]).toEqual({
      type: 'heading',
      depth: 2,
      data: { hProperties: { id: 'set-up' } },
      children: [{ type: 'text', value: 'Set up your workspace' }],
    });
  });

  it('leaves headings without a valid explicit marker unchanged', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'heading',
          depth: 2,
          children: [{ type: 'text', value: 'Set up {#Not Stable}' }],
        },
      ],
    };

    explicitHeadingIds()(tree);

    expect(tree.children[0]).toEqual({
      type: 'heading',
      depth: 2,
      children: [{ type: 'text', value: 'Set up {#Not Stable}' }],
    });
  });
});
