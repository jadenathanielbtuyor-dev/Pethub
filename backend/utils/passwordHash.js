// Password checks for PetHub accounts (Node's built-in crypto, no extra dependency).
// New passwords (registration and password reset) are stored as plain text, as typed (owner's decision, 2026-10-25).
// Accounts that already hold a salted scrypt hash keep it and still log in with it:
//   scrypt$<N>$<r>$<p>$<salt, base64>$<derived key, base64>
const crypto = require('crypto');
const util = require('util');

const scrypt = util.promisify(crypto.scrypt);

// Enough for a stored hash made with up to N = 65536, r = 8
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

// The value saved in users.password for a new or reset password
function toStoredPassword(password) {
  return String(password);
}

// Compares fixed-length digests so the time taken does not depend on where the two values differ
function plainTextMatches(candidate, storedPassword) {
  const digest = value => crypto.createHash('sha256').update(normalizePassword(value)).digest();
  return crypto.timingSafeEqual(digest(candidate), digest(storedPassword));
}

async function verifyPassword(password, storedPassword) {
  if (typeof storedPassword !== 'string' || storedPassword === '') return false;
  const candidate = String(password ?? '');

  const stored = parseScryptHash(storedPassword);
  if (!stored) return candidate !== '' && plainTextMatches(candidate, storedPassword);

  const key = await scrypt(normalizePassword(candidate), stored.salt, stored.key.length, {
    N: stored.N,
    r: stored.r,
    p: stored.p,
    maxmem: SCRYPT_MAX_MEMORY
  });
  return crypto.timingSafeEqual(key, stored.key);
}

module.exports = {
  toStoredPassword,
  verifyPassword,
  isPasswordHash
};
