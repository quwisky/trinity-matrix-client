import { createServer } from 'node:net';

export interface AndroidPortState {
  readonly ephemeralRange: readonly [number, number];
  readonly occupiedPorts: ReadonlySet<number>;
}

/** Parse both kernel socket tables, including connections still in TIME_WAIT. */
export function parseAndroidPortState(snapshot: string): AndroidPortState {
  const [range, ...lines] = snapshot.trim().split(/\r?\n/u);
  const match = range?.trim().match(/^(\d+)\s+(\d+)$/u);
  const first = Number(match?.[1]);
  const last = Number(match?.[2]);
  if (!match || first < 1 || last > 65535 || first > last) {
    throw new Error('Invalid Android ephemeral port range');
  }
  const families = new Set<number>();
  const occupiedPorts = new Set<number>();
  let addressWidth = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const header = line.match(/^\s*sl\s+local_address\s+(rem_address|remote_address)\s+st\b/u);
    if (header) {
      addressWidth = header[1] === 'rem_address' ? 8 : 32;
      if (families.has(addressWidth)) throw new Error('Duplicate Android socket table');
      families.add(addressWidth);
      continue;
    }
    const socket = line.match(/^\s*\d+:\s+([\da-fA-F]+):([\da-fA-F]{4})\s+/u);
    if (!socket || socket[1]!.length !== addressWidth) {
      throw new Error('Invalid Android socket table row');
    }
    occupiedPorts.add(Number.parseInt(socket[2]!, 16));
  }
  if (families.size !== 2) throw new Error('Missing Android IPv4 or IPv6 socket table');
  return { ephemeralRange: [first, last], occupiedPorts };
}

function hostPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    // Match Maestro's wildcard ServerSocket, not only the loopback interface.
    server.listen(port, () => {
      server.close(error => error ? reject(error) : resolve(true));
    });
  });
}

/** The same port is bound on the host and the Android driver, so check both. */
export async function allocateMaestroDriverPort(
  device: AndroidPortState,
  usedPorts: ReadonlySet<number>,
): Promise<number> {
  let hostProbes = 0;
  for (let port = 1024; port <= 65535; port++) {
    if (
      (port >= device.ephemeralRange[0] && port <= device.ephemeralRange[1]) ||
      device.occupiedPorts.has(port) || usedPorts.has(port)
    ) continue;
    // Avoid an unbounded scan on a heavily occupied host.
    if (++hostProbes > 64) break;
    if (await hostPortAvailable(port)) return port;
  }
  throw new Error('No available non-ephemeral Maestro driver port on host and Android');
}
