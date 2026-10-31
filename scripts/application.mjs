import { spawn } from 'node:child_process';
const production = process.argv.includes('--production');
const child = spawn(process.execPath, production ? ['build/server/index.js'] : ['--import', 'tsx', 'server/index.ts'], { stdio: 'inherit', env: { ...process.env, NODE_ENV: production ? 'production' : 'development' } });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code) => { process.exitCode = code || 0; });
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
