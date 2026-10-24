export interface EgoSdkInstallOptions {
  ready?: Promise<void>;
  cliLog?: (...args: unknown[]) => void;
}

export function installEgoSdk(
  target?: Record<string, unknown>,
  options?: EgoSdkInstallOptions,
): unknown;
