import { defineConfig } from 'vite';

import { createVitestConfig } from '../../vite.base.config';

// `passWithNoTests` used to be set here, and for a long time it was literally true: the
// composition root — runtime adapter, PUSH_CONFIG, encryption-dialog loaders and the
// service-worker enable predicate — had no unit coverage at all and
// `nx test trinity` was a green run over an empty file set. It has specs now, so the
// flag is gone: deleting them all should fail, not pass.
export default defineConfig(() => createVitestConfig(__dirname));
