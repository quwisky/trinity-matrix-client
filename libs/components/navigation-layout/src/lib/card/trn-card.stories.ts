import { type Meta, type StoryObj } from '@storybook/angular-vite';
import { TrnCard, TrnCardImports } from './trn-card';

const meta: Meta<TrnCard> = {
  title: 'Components/Card',
  component: TrnCard,
  decorators: [
    (story) => ({
      ...story(),
      moduleMetadata: { imports: [TrnCardImports] },
    }),
  ],
  parameters: {
    docs: {
      description: {
        component:
          'A semantic section surface with neutral or muted treatment and bounded small or medium geometry.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<TrnCard>;

const card = (variant: 'neutral' | 'muted', size: 'sm' | 'md') => `
  <section trnCard variant="${variant}" size="${size}" data-testid="card-${variant}-${size}" class="w-80">
    <div trnCardHeader>
      <h2 trnCardTitle>${variant === 'neutral' ? 'Account' : 'Workspace'}</h2>
      <p trnCardDescription>${size === 'sm' ? 'Compact supporting content.' : 'Standard supporting content.'}</p>
    </div>
    <div trnCardContent>Card content stays in the call site's semantic section.</div>
  </section>`;

/** Both semantic surfaces at the default medium geometry. */
export const SemanticSurfaces: Story = {
  render: () => ({
    template: `<div class="flex flex-wrap gap-4">${card('neutral', 'md')}${card('muted', 'md')}</div>`,
  }),
};

/** The only geometry choice: compact or default spacing. */
export const Geometry: Story = {
  render: () => ({
    template: `<div class="flex flex-wrap items-start gap-4">${card('neutral', 'sm')}${card('neutral', 'md')}</div>`,
  }),
};
