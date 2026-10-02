import { scrubDirectory } from './support/scrub.mts';

// Usage: node e2e/mobile/scrub-cli.mts <dir...>
for (const dir of process.argv.slice(2)) scrubDirectory(dir);
