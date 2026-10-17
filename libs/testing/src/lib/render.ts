import { type Type } from '@angular/core';
// The public option type comes from the NON-zoneless entry: its `inputs` / `on` are typed
// against the component. The `/zoneless` `RenderComponentOptions` declares no `inputs`/`on`.
import { type RenderComponentOptions } from '@testing-library/angular';
import {
  render as zonelessRender,
  type RenderComponentOptions as ZonelessRenderComponentOptions,
  type RenderResult,
} from '@testing-library/angular/zoneless';

export * from '@testing-library/angular/zoneless';
// Non-zoneless entry for the same reason: specs typing an `inputs` bag need it.
export type { ComponentInput } from '@testing-library/angular';

/**
 * Zoneless-aware `render` for our specs.
 *
 * ATL's `/zoneless` render() honors only Angular's `bindings` API and ignores the `inputs` /
 * `on` options our specs pass (a required signal input then throws NG0950), but `bindings`
 * would forbid the later `componentRef.setInput` many specs use (NG0317). So: render with
 * `skipDetectChanges`, apply `inputs` via `setInput` and wire `on` handlers BEFORE the first
 * change detection, then detect.
 */
export async function render<ComponentType>(
  component: Type<ComponentType>,
  options: RenderComponentOptions<ComponentType> = {},
): Promise<RenderResult<ComponentType>> {
  const { inputs, on, ...rest } = options;
  // The two libraries model `rest` as distinct option types; bridge it explicitly.
  const result = await zonelessRender(component, {
    ...(rest as ZonelessRenderComponentOptions),
    skipDetectChanges: true,
  });
  for (const [name, value] of Object.entries(inputs ?? {})) {
    result.fixture.componentRef.setInput(name, value);
  }
  const instance = result.fixture.componentInstance as Record<string, unknown>;
  for (const [name, handler] of Object.entries(on ?? {})) {
    (instance[name] as { subscribe?: (fn: unknown) => void })?.subscribe?.(
      handler,
    );
  }
  result.fixture.detectChanges();
  return result;
}
