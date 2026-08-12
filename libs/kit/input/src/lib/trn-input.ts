import { Directive } from '@angular/core';
import { BrnFieldControlDescribedBy } from '@spartan-ng/brain/field';
import { BrnInput } from '@spartan-ng/brain/input';
import { classes } from '@trinity/kit/utils';

@Directive({
  selector: '[trnInput]',
  hostDirectives: [
    { directive: BrnInput, inputs: ['id', 'forceInvalid'] , outputs: [] },
    // `inputs` is not optional here even though we forward nothing ourselves: a
    // hostDirectives entry publishes a composed directive's input only if it lists it, and
    // BrnFieldControlDescribedBy owns [attr.aria-describedby] as a host binding. Without
    // this, a consumer's aria-describedby — static or bound — was computed as null and
    // removed from the DOM, silently. See kit-components.spec.ts.
    { directive: BrnFieldControlDescribedBy, inputs: ['aria-describedby'] , outputs: [] }],
  host: { 'data-slot': 'input' },
})
export class TrnInput {
  constructor() {
    classes(
      () =>
        'dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring/50 data-[matches-spartan-invalid=true]:ring-destructive/20 dark:data-[matches-spartan-invalid=true]:ring-destructive/40 data-[matches-spartan-invalid=true]:border-destructive dark:data-[matches-spartan-invalid=true]:border-destructive/50 disabled:bg-input/50 dark:disabled:bg-input/80 h-8 rounded-lg border bg-transparent px-2.5 py-1 text-base transition-colors file:h-6 file:text-sm file:font-medium focus-visible:ring-3 data-[matches-spartan-invalid=true]:ring-3 md:text-sm file:text-foreground placeholder:text-muted-foreground w-full min-w-0 outline-none file:inline-flex file:border-0 file:bg-transparent disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
    );
  }
}
