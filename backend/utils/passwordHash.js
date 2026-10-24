// Password storage for PetHub accounts (Node's built-in crypto, no extra dependency).
// New passwords (registration and password reset) are stored as salted scrypt hashes:
//   scrypt$<N>$<r>$<p>$<salt, base64>$<derived key, base64>
// Only these hashes ever verify. Values saved before hashing (plaintext, sha256$<hex>) are no longer accepted: their
// owners set a new password with "Forgot password?" (database/migrations/2026-10-24_remove_legacy_plaintext_password.sql
// removed the last one), so a password that was readable in the database never works again.
const crypto = require('crypto');
const util = require('util');

const scrypt = util.promisify(crypto.scrypt);

const SCRYPT_COST = Object.freeze({ N: 16384, r: 8, p: 1 });
const SALT_BYTES = 16;
const KEY_BYTES = 64;
// Enough for the parameters above (128 * N * r = 16 MiB) and for a stored hash made with up to N = 65536
const SCRYPT_MAX_MEMORY = 128 * 65536 * 8 * 2;

const SCRYPT_HASH_PATTERN = /^scrypt\$(\d{4,6})\$(\d{1,2})\$(\d)\$([A-Za-z0-9+/]{22}==)\$([A-Za-z0-9+/]{86}==)$/;

function normalizePassword(password) {
  return String(password).normalize('NFC');
}

// Returns the scrypt settings of a stored hash, or null when the value is not a PetHub scrypt hash
function parseScryptHash(storedPassword) {
  const match = SCRYPT_HASH_PATTERN.exec(storedPassword);
  if (!match) return null;

  const [N, r, p] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const isPowerOfTwo = (N & (N - 1)) === 0;
  if (!isPowerOfTwo || N < 1024 || N > 65536 || r < 1 || r > 16 || p < 1 || p > 4) return null;

  return { N, r, p, salt: Buffer.from(match[4], 'base64'), key: Buffer.from(match[5], 'base64') };
}

function isPasswordHash(storedPassword) {
  return typeof storedPassword === 'string' && parseScryptHash(storedPassword) !== null;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scrypt(normalizePassword(password), salt, KEY_BYTES, { ...SCRYPT_COST, maxmem: SCRYPT_MAX_MEMORY });
  const { N, r, p } = SCRYPT_COST;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, storedPassword) {
  if (typeof storedPassword !== 'string' || storedPassword === '') return false;
  const candidate = String(password ?? '');

  const stored = parseScryptHash(storedPassword);
  if (!stored) return false;

  const key = await scrypt(normalizePassword(candidate), stored.salt, stored.key.length, {
    N: stored.N,
    r: stored.r,
    p: stored.p,
    maxmem: SCRYPT_MAX_MEMORY
  });
  return crypto.timingSafeEqual(key, stored.key);
}

module.exports = {
  hashPassword,
  verifyPassword,
  isPasswordHash
};
