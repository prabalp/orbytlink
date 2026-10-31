import { createServer } from 'node:net';

export function isPortAvailable(port, host) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(new Error(`Cannot check ${host}:${port}: ${error.code || error.message}`));
    });
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export async function planPorts(env, production, available = isPortAvailable) {
  const definitions = [
    { name: 'frontend', value: env.PORT || '3100', fixed: Boolean(env.PORT || env.APP_ORIGIN), host: '127.0.0.1' },
    { name: 'api', value: env.V0_API_PORT || (production ? env.PORT || '3100' : '3080'), fixed: Boolean(env.V0_API_PORT), host: env.HOST || '127.0.0.1' },
    { name: 'workstation', value: env.WORKSTATION_PORT || '3101', fixed: Boolean(env.WORKSTATION_PORT), host: '127.0.0.1' },
  ].filter((definition) => !production || definition.name !== 'frontend');
  for (const definition of definitions) {
    const port = Number(definition.value);
    if (!/^\d+$/.test(definition.value) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid ${definition.name} port: use an integer from 1 to 65535.`);
    }
    definition.port = port;
    definition.fixed ||= production;
  }
  const preferred = new Set(definitions.map((definition) => definition.port));
  const used = new Set();
  const ports = {};
  const notices = [];
  // Honor explicit configuration before assigning ports for default services.
  const ordered = [...definitions.filter((d) => d.fixed), ...definitions.filter((d) => !d.fixed)];
  for (const definition of ordered) {
    let port = definition.port;
    while (used.has(port) || !(await available(port, definition.host))) {
      if (definition.fixed) {
        throw new Error(`${definition.name} port ${port} is already in use or assigned to another service. Set distinct PORT, V0_API_PORT, and WORKSTATION_PORT values, or stop the process using that port.`);
      }
      do { port += 1; } while (preferred.has(port) || used.has(port));
      if (port > 65535 || port - definition.port > 100) {
        throw new Error(`Could not find a free port for ${definition.name}. Configure its port explicitly.`);
      }
    }
    used.add(port);
    ports[definition.name] = String(port);
    if (port !== definition.port) notices.push(`${definition.name} port ${definition.port} is unavailable; using ${port}.`);
  }
  if (production) ports.frontend = ports.api;
  return { ...ports, notices };
}
