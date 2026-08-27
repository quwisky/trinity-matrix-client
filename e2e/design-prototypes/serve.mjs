import { serve } from '../support/serve.mjs';

const port = Number(process.env.PORT ?? 4402);
await serve('www', port, {
  '/__design__': 'e2e/design-prototypes',
});
console.log(
  `[design prototypes] serving on http://localhost:${port}/__design__/`,
);
