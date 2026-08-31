import { runProtocolCompatibility } from '../support/protocol-runner.mts';

process.exitCode = await runProtocolCompatibility('spaces');
