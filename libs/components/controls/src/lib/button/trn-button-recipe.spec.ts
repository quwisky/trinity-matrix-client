import { describe, expect, it } from 'vitest';
import {
  trnButtonRecipe,
  type TrnButtonPresentation,
  type TrnButtonShape,
  type TrnButtonSize,
  type TrnButtonVariant,
} from './trn-button-recipe';

it('carries no dark: text variants, which have no Helm class to override', () => {
  const presentations = ['solid', 'outline', 'ghost', 'link'] as const;
  const variants = ['primary', 'secondary', 'danger'] as const;
  for (const presentation of presentations) {
    for (const variant of variants) {
      expect(
        trnButtonRecipe({
          presentation,
          shape: 'label',
          size: 'md',
          variant,
        }),
      ).not.toMatch(/dark:hover:text-/u);
    }
  }
});

it('lets a row shape wrap its label instead of keeping the fixed height and nowrap', () => {
  const row = trnButtonRecipe({
    presentation: 'ghost',
    shape: 'row',
    size: 'sm',
    variant: 'primary',
  }).split(' ');

  expect(row).toEqual(
    expect.arrayContaining([
      'h-auto',
      'w-full',
      'justify-start',
      'whitespace-normal',
    ]),
  );
  expect(row).not.toContain('h-7');
  expect(row).not.toContain('whitespace-nowrap');
});

describe('inline shape', () => {
  const SIZES = ['xs', 'sm', 'md', 'lg'] as const;
  const SIZE_PADDING = {
    xs: 'px-2',
    sm: 'px-2.5',
    md: 'px-2.5',
    lg: 'px-2.5',
  };
  const INLINE_CLASSES = [
    'px-0',
    'has-data-[icon=inline-end]:pe-0',
    'has-data-[icon=inline-start]:ps-0',
  ];

  function recipe(
    shape: TrnButtonShape,
    size: TrnButtonSize,
    presentation: TrnButtonPresentation = 'link',
  ): string[] {
    return trnButtonRecipe({
      presentation,
      shape,
      size,
      variant: 'primary',
    }).split(' ');
  }

  it('drops all inline padding, icons included, so the label lines up with the text column', () => {
    for (const size of SIZES) {
      const inline = recipe('inline', size);

      expect(inline).toEqual(expect.arrayContaining(INLINE_CLASSES));
      expect(inline).not.toContain(SIZE_PADDING[size]);
    }
  });

  it('keeps its height and width: it is not a full-width row', () => {
    for (const size of SIZES) {
      const inline = recipe('inline', size);

      expect(inline).not.toContain('h-auto');
      expect(inline).not.toContain('w-full');
      expect(inline).not.toContain('whitespace-normal');
    }
  });

  it('keeps the shared focus ring', () => {
    for (const presentation of ['link', 'ghost'] as const) {
      expect(recipe('inline', 'sm', presentation)).toEqual(
        expect.arrayContaining([
          'focus-visible:border-[color:var(--trinity-focus-ring)]',
          'focus-visible:ring-[color:var(--trinity-focus-ring)]',
          'dark:focus-visible:ring-[color:var(--trinity-focus-ring)]',
        ]),
      );
    }
  });

  it('leaves the label shape as it was', () => {
    for (const size of SIZES) {
      const label = recipe('label', size);
      const inline = recipe('inline', size);

      expect(label).toContain(SIZE_PADDING[size]);
      for (const added of INLINE_CLASSES) {
        expect(label).not.toContain(added);
      }
      // Only the inline padding, plain and beside an icon, differs between the shapes.
      const inlinePadding =
        /^(?:px-|has-data-\[icon=inline-(?:end|start)\]:p[es]-)/u;
      expect(label.filter((name) => !inlinePadding.test(name))).toEqual(
        inline.filter((name) => !inlinePadding.test(name)),
      );
    }
  });
});

it('renders a solid danger action as a filled danger button, not a tint', () => {
  const solidDanger = trnButtonRecipe({
    presentation: 'solid',
    shape: 'label',
    size: 'md',
    variant: 'danger',
  });

  expect(solidDanger).toContain('bg-[color:var(--trinity-danger-solid)]');
  expect(solidDanger).toContain(
    'text-[color:var(--trinity-danger-solid-foreground)]',
  );
  expect(solidDanger).toContain(
    'hover:bg-[color:var(--trinity-danger-solid-hover)]',
  );
  expect(solidDanger).toContain(
    'dark:hover:bg-[color:var(--trinity-danger-solid-hover)]',
  );
  expect(solidDanger).not.toContain('dark:hover:bg-destructive/30');
  expect(solidDanger).not.toContain('bg-destructive/10');
  expect(solidDanger).not.toContain('dark:bg-destructive/20');
  expect(solidDanger).not.toContain('text-destructive');
});

it('inverts a solid primary action only inside an attention surface', () => {
  const recipe = (
    variant: TrnButtonVariant,
    presentation: TrnButtonPresentation,
  ) => trnButtonRecipe({ presentation, shape: 'label', size: 'sm', variant });
  const attention = 'in-data-[trn-surface=attention]:';
  const solidPrimary = recipe('primary', 'solid').split(' ');

  // The accent fill stays the default; the attention classes only add a scoped override.
  expect(solidPrimary).toContain('bg-primary');
  expect(solidPrimary).toEqual(
    expect.arrayContaining([
      `${attention}bg-[color:var(--trinity-state-attention-action-surface)]`,
      `${attention}text-[color:var(--trinity-state-attention-action-foreground)]`,
      `${attention}hover:bg-[color:var(--trinity-state-attention-action-hover-surface)]`,
      // Helm's anchor hover outranks the plain one, so anchors carry their own copy.
      `${attention}[a]:hover:bg-[color:var(--trinity-state-attention-action-hover-surface)]`,
    ]),
  );
  // None of the attention roles applies unscoped, which would repaint every primary button.
  for (const unscoped of [
    'bg-[color:var(--trinity-state-attention-action-surface)]',
    'text-[color:var(--trinity-state-attention-action-foreground)]',
    'hover:bg-[color:var(--trinity-state-attention-action-hover-surface)]',
  ]) {
    expect(solidPrimary).not.toContain(unscoped);
  }
  for (const [variant, presentation] of [
    ['secondary', 'solid'],
    ['danger', 'solid'],
    ['primary', 'ghost'],
  ] as const) {
    expect(recipe(variant, presentation)).not.toContain(attention);
  }
});

it('preserves semantic tone across non-solid presentations', () => {
  const primaryGhost = trnButtonRecipe({
    presentation: 'ghost',
    shape: 'label',
    size: 'md',
    variant: 'primary',
  });
  const secondaryGhost = trnButtonRecipe({
    presentation: 'ghost',
    shape: 'label',
    size: 'md',
    variant: 'secondary',
  });
  const dangerGhost = trnButtonRecipe({
    presentation: 'ghost',
    shape: 'label',
    size: 'md',
    variant: 'danger',
  });

  expect(secondaryGhost).not.toBe(primaryGhost);
  expect(secondaryGhost).toContain('text-secondary-foreground');
  expect(secondaryGhost).toContain('dark:hover:bg-secondary');
  expect(dangerGhost).not.toBe(primaryGhost);
  expect(dangerGhost).toContain('text-danger');
  expect(dangerGhost).toContain('hover:bg-[var(--trinity-danger-tint-10)]');
  expect(dangerGhost).toContain(
    'dark:hover:bg-[var(--trinity-danger-tint-10)]',
  );
});

it('gives outline buttons the control border, and danger outlines a danger border in both modes', () => {
  const outline = (variant: TrnButtonVariant) =>
    trnButtonRecipe({
      presentation: 'outline',
      shape: 'label',
      size: 'md',
      variant,
    });

  for (const variant of ['primary', 'secondary'] as const) {
    expect(outline(variant)).toContain(
      'border-[color:var(--trinity-border-control)]',
    );
    expect(outline(variant)).toContain(
      'dark:border-[color:var(--trinity-border-control)]',
    );
    expect(outline(variant)).not.toContain('border-border');
    expect(outline(variant)).not.toContain('dark:border-input');
  }
  expect(outline('danger')).toContain('border-danger');
  expect(outline('danger')).toContain('dark:border-danger');
  expect(outline('danger')).not.toContain('dark:border-input');
});

it('separates a solid primary focus ring from its fill with a gap that shows the surface behind', () => {
  const separatedRing = [
    'focus-visible:border-transparent',
    'focus-visible:ring-0',
    'focus-visible:outline-solid',
    'focus-visible:outline-[length:var(--trinity-focus-ring-width)]',
    'focus-visible:outline-offset-[length:var(--trinity-focus-ring-offset)]',
    'focus-visible:outline-[color:var(--trinity-focus-ring)]',
  ];
  for (const shape of ['label', 'icon', 'row', 'inline'] as const) {
    for (const size of ['xs', 'sm', 'md', 'lg'] as const) {
      const solidPrimary = trnButtonRecipe({
        presentation: 'solid',
        shape,
        size,
        variant: 'primary',
      }).split(' ');

      expect(solidPrimary).toEqual(expect.arrayContaining(separatedRing));
      // Neither a ring nor a focus border may sit flush against the fill, on any surface.
      expect(solidPrimary).not.toContain('focus-visible:ring-3');
      expect(solidPrimary).not.toContain('focus-visible:border-ring');
      expect(solidPrimary).not.toContain(
        'focus-visible:border-[color:var(--trinity-focus-ring)]',
      );
      expect(solidPrimary).not.toContain(
        'focus-visible:ring-[color:var(--trinity-focus-ring)]',
      );
      expect(
        solidPrimary.filter((name) => /(^|:)ring-offset-/u.test(name)),
      ).toEqual([]);
    }
  }

  for (const [variant, presentation] of [
    ['secondary', 'solid'],
    ['danger', 'solid'],
    ['primary', 'outline'],
    ['primary', 'ghost'],
    ['primary', 'link'],
    ['danger', 'outline'],
  ] as const) {
    const recipe = trnButtonRecipe({
      presentation,
      shape: 'label',
      size: 'md',
      variant,
    }).split(' ');

    expect(recipe).toEqual(
      expect.arrayContaining([
        'focus-visible:ring-3',
        'focus-visible:border-[color:var(--trinity-focus-ring)]',
        'focus-visible:ring-[color:var(--trinity-focus-ring)]',
      ]),
    );
    expect(recipe.some((name) => name.includes(':outline-'))).toBe(false);
  }
});

it('shares the global focus ring across every presentation and variant', () => {
  for (const presentation of ['solid', 'outline', 'ghost', 'link'] as const) {
    for (const variant of ['primary', 'secondary', 'danger'] as const) {
      if (presentation === 'solid' && variant === 'primary') continue;
      const recipe = trnButtonRecipe({
        presentation,
        shape: 'icon',
        size: 'md',
        variant,
      });

      expect(recipe).toContain(
        'focus-visible:ring-[color:var(--trinity-focus-ring)]',
      );
      expect(recipe).not.toMatch(/focus-visible:ring-(ring|destructive)/);
    }
  }
});

it('keeps an outline action transparent with attention roles only inside an attention surface', () => {
  const recipe = (
    variant: TrnButtonVariant,
    presentation: TrnButtonPresentation,
  ) =>
    trnButtonRecipe({
      presentation,
      shape: 'label',
      size: 'sm',
      variant,
    }).split(' ');
  const onAttention = [
    'in-data-[trn-surface=attention]:border-[color:var(--trinity-state-attention-control-border)]',
    'in-data-[trn-surface=attention]:dark:border-[color:var(--trinity-state-attention-control-border)]',
    'in-data-[trn-surface=attention]:bg-transparent',
    'in-data-[trn-surface=attention]:dark:bg-transparent',
    'in-data-[trn-surface=attention]:text-[color:var(--trinity-state-attention-control-foreground)]',
    'in-data-[trn-surface=attention]:hover:bg-[color:var(--trinity-state-attention-action-hover-surface)]',
    'in-data-[trn-surface=attention]:dark:hover:bg-[color:var(--trinity-state-attention-action-hover-surface)]',
    'in-data-[trn-surface=attention]:hover:text-[color:var(--trinity-state-attention-action-foreground)]',
    // Helm's `aria-expanded:` grey chip would paint on the accent while a menu is open.
    'in-data-[trn-surface=attention]:aria-expanded:bg-transparent',
    'in-data-[trn-surface=attention]:aria-expanded:text-[color:var(--trinity-state-attention-control-foreground)]',
  ];

  for (const variant of ['primary', 'secondary'] as const) {
    const outline = recipe(variant, 'outline');
    // The neutral border stays the default; the attention roles only add a scoped override.
    expect(outline).toEqual(
      expect.arrayContaining([
        'border-[color:var(--trinity-border-control)]',
        'dark:border-[color:var(--trinity-border-control)]',
        ...onAttention,
      ]),
    );
    expect(outline.filter((token) => token.includes('attention'))).toEqual(
      outline.filter((token) =>
        token.startsWith('in-data-[trn-surface=attention]:'),
      ),
    );
  }
  // A danger outline keeps its danger roles: no danger colour reaches 4.5:1 on the accent.
  expect(recipe('danger', 'outline').join(' ')).not.toContain(
    'in-data-[trn-surface=attention]:',
  );
});
