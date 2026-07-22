import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = process.env.PTT_CONFIG || join(__dirname, '..', 'config', 'users.json');

const raw = JSON.parse(readFileSync(configPath, 'utf8'));

export const config = {
  jwtSecret: process.env.JWT_SECRET || raw.jwtSecret || 'dev-secret',
  channels: raw.channels || [],
  users: raw.users || [],
  port: Number(process.env.PORT) || 3000,
};
