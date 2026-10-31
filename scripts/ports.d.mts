export function isPortAvailable(port: number, host: string): Promise<boolean>;
export function planPorts(
  env: Record<string, string | undefined>,
  production: boolean,
  available?: (port: number, host: string) => Promise<boolean>,
): Promise<{ frontend: string; api: string; workstation: string; notices: string[] }>;
