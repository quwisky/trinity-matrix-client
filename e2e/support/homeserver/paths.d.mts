// Type declarations for paths.mjs — see start.d.mts for why the harness stays plain JS.
export declare const HERE: string;
export declare const STATE_DIR: string;
export declare const DATA: string;
export declare const REMOTE_DATA: string;
export declare function resolveNetworkContainer(): Promise<string>;
export declare function composeFiles(
  kind: string,
  networkContainer: string,
): string[];
export declare function prepareStateDir(
  configFiles?: readonly string[],
): Promise<void>;
