// Type declarations for the port exports of constants.mjs — see start.d.mts for why the
// harness stays plain JS. The other constants are declared in start.d.mts.
export interface HomeserverPorts {
  readonly homeserver: number;
  readonly secondary: number;
  readonly tls: number;
  readonly identity: number;
  readonly sydent: number;
  readonly dex: number;
  readonly mailpit: number;
  readonly smtp: number;
  readonly linkPreview: number;
  readonly masHomeserver: number;
  readonly masIssuer: number;
}
export declare function resolvePortOffset(env?: NodeJS.ProcessEnv): number;
export declare const PORT_OFFSET: number;
export declare const PORTS: HomeserverPorts;
export declare function offsetPorts(text: string, offset?: number): string;
