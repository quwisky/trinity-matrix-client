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
import {
  TrnSeparatorDirective,
  type TrnSeparatorVariant,
} from './separator/trn-separator.directive';
import { TrnTabPanelComponent } from './tabs/trn-tab-panel.component';
import {
  TrnTabsComponent,
  type TrnTabsPresentation,
  type TrnTabsVariant,
} from './tabs/trn-tabs.component';

const completeCatalog =
  <Union>() =>
  <const Values extends readonly Union[]>(
    values: Values & ([Union] extends [Values[number]] ? unknown : never),
  ): Values =>
    values;

const TAB_VARIANTS = completeCatalog<TrnTabsVariant>()(['neutral', 'accent']);
const TAB_PRESENTATIONS = completeCatalog<TrnTabsPresentation>()([
  'pill',
  'line',
]);
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
const SEPARATOR_VARIANTS = completeCatalog<TrnSeparatorVariant>()([
  'neutral',
  'accent',
]);

const TAB_CATALOG = TAB_VARIANTS.flatMap((variant) =>
  TAB_PRESENTATIONS.map((presentation) => {
    const prefix = `${variant}-${presentation}`;
    return {
      variant,
      presentation,
      active: `${prefix}-overview`,
      tabs: [
        { value: `${prefix}-overview`, label: 'Overview' },
        { value: `${prefix}-members`, label: 'Members' },
        { value: `${prefix}-security`, label: 'Security' },
      ],
    } as const;
  }),
);
const STATE_TABS = [
  { value: 'overview', label: 'Overview' },
  {
    value: 'translations',
    label: 'A deliberately long translated navigation label',
  },
  { value: 'unavailable', label: 'Unavailable', disabled: true },
] as const;

const meta: Meta = {
  title: 'Components/Navigation and layout recipe matrix',
  decorators: [
    moduleMetadata({
      imports: [
        PageHeaderComponent,
        TrnCardImports,
        TrnSeparatorDirective,
        TrnTabPanelComponent,
        TrnTabsComponent,
      ],
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
      separatorVariants: SEPARATOR_VARIANTS,
      stateTabs: STATE_TABS,
      tabCatalog: TAB_CATALOG,
    },
    template: `
      <main class="grid min-w-0 gap-10 p-6" data-testid="complete-navigation-layout-catalog">
        <h1 class="text-xl font-semibold">Navigation and layout catalog</h1>

        <section class="grid min-w-0 gap-4" aria-labelledby="catalog-tabs">
          <h2 id="catalog-tabs" class="text-lg font-semibold">Tabs</h2>
          @for (catalog of tabCatalog; track catalog.active) {
            <div class="min-w-0 overflow-x-auto pb-2">
              <trn-tabs
                [attr.data-testid]="'catalog-tabs-' + catalog.variant + '-' + catalog.presentation"
                [tab]="catalog.active"
                [tabs]="catalog.tabs"
                [variant]="catalog.variant"
                [presentation]="catalog.presentation"
              >
                @for (tab of catalog.tabs; track tab.value) {
                  <trn-tab-panel [value]="tab.value">{{ tab.label }} content</trn-tab-panel>
                }
              </trn-tabs>
            </div>
          }
          <div class="min-w-0 overflow-x-auto pb-2">
            <trn-tabs
              data-testid="catalog-tabs-manual-vertical"
              tab="overview"
              activationMode="manual"
              orientation="vertical"
              [tabs]="stateTabs"
              presentation="line"
            >
              <trn-tab-panel value="overview">Overview state</trn-tab-panel>
              <trn-tab-panel value="translations">Translated state</trn-tab-panel>
              <trn-tab-panel value="unavailable">Unavailable state</trn-tab-panel>
            </trn-tabs>
          </div>
        </section>

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
                    <h3 trnCardTitle>{{ variant }} {{ size }} card</h3>
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

        <section class="grid gap-4" aria-labelledby="catalog-separators">
          <h2 id="catalog-separators" class="text-lg font-semibold">Separators</h2>
          @for (variant of separatorVariants; track variant) {
            <div
              trnSeparator
              [variant]="variant"
              [attr.data-testid]="'catalog-separator-' + variant + '-horizontal-decorative'"
            ></div>
            <div class="flex h-10 items-center gap-3">
              <span>Before</span>
              <div
                trnSeparator
                orientation="vertical"
                [decorative]="false"
                [variant]="variant"
                [attr.data-testid]="'catalog-separator-' + variant + '-vertical-announced'"
              ></div>
              <span>After</span>
            </div>
          }
        </section>
      </main>
    `,
  }),
};
