import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from './config.js';

// Seed users are stored with plaintext demo passwords in config/users.json.
// We hash them once at startup so we never keep the plaintext around and so the
// comparison path mirrors what a real deployment (with a DB of hashes) would do.
// NOTE: this is demo auth. Replace the config store with a real user database
// and proper password hashing / signup flow before using in production.
const users = new Map();
for (const u of config.users) {
  users.set(u.username, {
    username: u.username,
    role: u.role || 'user',
    channels: u.channels || [],
    passwordHash: bcrypt.hashSync(u.password, 8),
  });
}

const TOKEN_TTL = '12h';

export function login(username, password) {
  const user = users.get(username);
  if (!user) return null;
  if (!bcrypt.compareSync(password, user.passwordHash)) return null;
  const token = jwt.sign(
    { sub: user.username, role: user.role, channels: user.channels },
    config.jwtSecret,
    { expiresIn: TOKEN_TTL }
  );
  return { token, user: publicUser(user) };
}

export function verifyToken(token) {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    return {
      username: payload.sub,
      role: payload.role,
      channels: payload.channels || [],
    };
  } catch {
    return null;
  }
}

// Which channels may this user (from a verified token) access?
export function allowedChannels(principal) {
  const all = config.channels;
  if (principal.channels.includes('*')) return all;
  return all.filter((c) => principal.channels.includes(c.id));
}

export function canAccessChannel(principal, channelId) {
  if (principal.channels.includes('*')) {
    return config.channels.some((c) => c.id === channelId);
  }
  return principal.channels.includes(channelId);
}

function publicUser(user) {
  return { username: user.username, role: user.role, channels: user.channels };
}
