import { Directive } from '@angular/core';
import { BrnSelectValueTemplate } from '@spartan-ng/brain/select';

@Directive({ selector: '[hlmSelectValueTemplate]', hostDirectives: [
    { directive: BrnSelectValueTemplate, inputs: [] },
  ] })
export class HlmSelectValueTemplate {}
