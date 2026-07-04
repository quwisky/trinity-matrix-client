import baseConfig from '../../../eslint.config.mjs';

// libs/spartan/** is canonical helm code; extend the root flat config directly
// (same rationale as the sibling helm libs).
export default [...baseConfig];
