import {
  type Meta,
  moduleMetadata,
  type StoryObj,
} from '@storybook/angular-vite';
import {
  TrnCardImports,
  type TrnCardSize,
  type TrnCardVariant,
} from './card/trn-card';
import {
  PageHeaderComponent,
  type TrnPageHeaderLayout,
  type TrnPageHeaderVariant,
} from './page-header/page-header.component';

const completeCatalog =
  <Union>() =>
  <const Values extends readonly Union[]>(
    values: Values & ([Union] extends [Values[number]] ? unknown : never),
  ): Values =>
    values;

const CARD_VARIANTS = completeCatalog<TrnCardVariant>()(['neutral', 'muted']);
const CARD_SIZES = completeCatalog<TrnCardSize>()(['sm', 'md']);
const HEADER_VARIANTS = completeCatalog<TrnPageHeaderVariant>()([
  'neutral',
  'accent',
]);
const HEADER_LAYOUTS = completeCatalog<TrnPageHeaderLayout>()([
  'page',
  'toolbar',
]);

const meta: Meta = {
  title: 'Components/Navigation and layout recipe matrix',
  decorators: [
    moduleMetadata({
      imports: [PageHeaderComponent, TrnCardImports],
    }),
  ],
};

export default meta;
type Story = StoryObj;

/** Every public Navigation and Layout treatment, geometry, and behavior axis. */
export const CompleteCatalog: Story = {
  render: () => ({
    props: {
      cardSizes: CARD_SIZES,
      cardVariants: CARD_VARIANTS,
      headerLayouts: HEADER_LAYOUTS,
      headerVariants: HEADER_VARIANTS,
    },
    template: `
      <main class="grid min-w-0 gap-10 p-6" data-testid="complete-navigation-layout-catalog">
        <h1 class="text-xl font-semibold">Navigation and layout catalog</h1>

        <section class="grid gap-4" aria-labelledby="catalog-cards">
          <h2 id="catalog-cards" class="text-lg font-semibold">Cards</h2>
          <div class="flex flex-wrap items-start gap-4">
            @for (variant of cardVariants; track variant) {
              @for (size of cardSizes; track size) {
                <section
                  trnCard
                  [variant]="variant"
                  [size]="size"
                  [attr.data-testid]="'catalog-card-' + variant + '-' + size"
                  class="w-72 max-w-full"
                >
                  <div trnCardHeader>
                    <h3>{{ variant }} {{ size }} card</h3>
                    <p trnCardDescription>Semantic surface and bounded geometry.</p>
                  </div>
                  <p trnCardContent>Representative card content.</p>
                </section>
              }
            }
          </div>
        </section>

        <section class="grid gap-4" aria-labelledby="catalog-headers">
          <h2 id="catalog-headers" class="text-lg font-semibold">Page headers</h2>
          @for (variant of headerVariants; track variant) {
            @for (layout of headerLayouts; track layout) {
              <trn-page-header
                [attr.data-testid]="'catalog-header-' + variant + '-' + layout"
                [title]="variant + ' ' + layout + ' header'"
                [variant]="variant"
                [layout]="layout"
              >
                <button trnHeaderLeading type="button" class="font-semibold">Back</button>
                <button trnHeaderActions type="button">Action</button>
              </trn-page-header>
            }
          }
        </section>
      </main>
    `,
  }),
};
