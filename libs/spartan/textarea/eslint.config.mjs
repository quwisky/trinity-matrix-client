import baseConfig from '../../../eslint.config.mjs';

// The app-root flat config already handles libs/spartan/** (helm hlm/brn selector
// prefixes, un-suffixed class names, aliased inputs) and the module boundaries via
// this lib's type:ui/scope:trinity tags. The generator's per-lib config referenced
// @nx/@typescript-eslint plugins in blocks that do not register them (breaks under
// this repo's eslint), so extend the root config directly.
export default [...baseConfig];
