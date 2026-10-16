const crypto = require('crypto');
const { sendEmail } = require('../utils/email');
const env = require('../config/env');
const { buildPasswordResetEmail } = require('../templates/email/passwordResetEmail');
const { logUserActivity } = require('../utils/activityLogger');
const { AUTH_TOKEN_MIN_SECRET_LENGTH } = require('../constants/auth');
const {
  PASSWORD_RESET_CODE_TTL_MINUTES,
  PASSWORD_RESET_RESEND_COOLDOWN_SECONDS,
  PASSWORD_RESET_MAX_ATTEMPTS
} = require('../constants/email');
const usersRepository = require('../repositories/usersRepository');
const passwordResetsRepository = require('../repositories/passwordResetsRepository');
const {
  validatePasswordResetRequest,
  validatePasswordReset
} = require('../validators/authValidator');

// The same reply for every email address, so these endpoints can't be used to find out who has an account
const RESET_CODE_REQUESTED = { statusCode: 200, body: {
  success: true,
  message: `If an account exists for that email, a reset code has been sent. It expires in ${PASSWORD_RESET_CODE_TTL_MINUTES} minutes.`
} };
const INVALID_RESET_CODE = { statusCode: 400, body: { success: false, error: 'Invalid or expired reset code. Check the code or request a new one.' } };
const RESET_UNAVAILABLE = { statusCode: 500, body: { success: false, error: 'Password reset is temporarily unavailable. Please try again later.' } };
const ATTEMPT_RESERVATION_TRIES = 5;
// Postgres unique_violation: the one-open-code-per-user index rejected a second open code
const UNIQUE_VIOLATION = '23505';

function getResetCodeKey() {
  const secret = env.auth.tokenSecret;
  if (!secret || secret.length < AUTH_TOKEN_MIN_SECRET_LENGTH) return null;
  // A key of its own, derived from the session secret, so stored code hashes are useless without the server secret
  return crypto.createHmac('sha256', secret).update('pethub:password-reset-code:v1').digest();
}

// Checked before any account lookup, so a misconfigured server gives every email address the same reply
function getConfiguredResetCodeKey() {
  const key = getResetCodeKey();
  if (!key) {
    console.error('Password reset unavailable: AUTH_TOKEN_SECRET is not configured');
    return null;
  }
  if (!passwordResetsRepository.isConfigured()) {
    console.error('Password reset unavailable: SUPABASE_SERVICE_KEY is not configured');
    return null;
  }
  return key;
}

// supabase-js returns PostgREST's error body, whose code is a Postgres SQLSTATE when the database rejected the
// statement; PostgREST then rolled it back, so nothing changed. Errors without one (network failure, timeout, gateway
// page) and connection (08) or shutdown (57) errors may have come after the change was saved, so they count as unknown.
function isDefiniteDatabaseRejection(error) {
  const code = String((error && error.code) || '');
  return /^[0-9A-Z]{5}$/.test(code) && !code.startsWith('08') && !code.startsWith('57');
}

function hashResetCode(key, userId, code) {
  return crypto.createHmac('sha256', key).update(`${userId}:${code}`).digest('hex');
}

function resetCodeMatches(key, userId, code, storedHash) {
  const expected = Buffer.from(hashResetCode(key, userId, code), 'hex');
  const stored = Buffer.from(String(storedHash || ''), 'hex');
  return stored.length === expected.length && crypto.timingSafeEqual(stored, expected);
}

function generateResetCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function logDatabaseError(label, error) {
  console.error(label, { code: error && error.code, message: error && error.message });
}

function sendPasswordResetEmail(user, code) {
  const email = buildPasswordResetEmail({ name: user.fullname, code });
  return sendEmail({ to: user.email, ...email }).catch(async (error) => {
    console.error('Password reset email error:', error.message);
    await logUserActivity(user.id, 'password_reset_email_failed', `Password reset email could not be sent: ${error.message}`);
  });
}

const requestPasswordReset = async (req) => {
  try {
    const validation = validatePasswordResetRequest(req.body);
    if (validation.error) return validation.error;

    const { normalizedEmail } = validation;
    const key = getConfiguredResetCodeKey();
    if (!key) return RESET_UNAVAILABLE;

    const { data: users, error: userError } = await usersRepository.findByEmailForVerification(normalizedEmail);
    if (userError) {
      logDatabaseError('Password reset user lookup error:', userError);
      return RESET_UNAVAILABLE;
    }

    const user = users && users[0];
    if (!user) return RESET_CODE_REQUESTED;

    // From here on, failures are logged but still get the generic reply so they don't reveal the account
    const { data: latestRows, error: latestError } = await passwordResetsRepository.findLatestByUserId(user.id);
    if (latestError) {
      logDatabaseError('Password reset lookup error:', latestError);
      return RESET_CODE_REQUESTED;
    }

    const latest = latestRows && latestRows[0];
    if (latest && Date.now() - new Date(latest.created_at).getTime() < PASSWORD_RESET_RESEND_COOLDOWN_SECONDS * 1000) {
      return RESET_CODE_REQUESTED;
    }

    const now = new Date();
    const cooldownStart = new Date(now.getTime() - PASSWORD_RESET_RESEND_COOLDOWN_SECONDS * 1000).toISOString();
    const { error: invalidateError } = await passwordResetsRepository.invalidateOpenByUserId(user.id, now.toISOString(), cooldownStart);
    if (invalidateError) {
      logDatabaseError('Password reset invalidate error:', invalidateError);
      return RESET_CODE_REQUESTED;
    }

    const code = generateResetCode();
    const { error: insertError } = await passwordResetsRepository.createReset({
      user_id: user.id,
      reset_token: hashResetCode(key, user.id, code),
      expires_at: new Date(now.getTime() + PASSWORD_RESET_CODE_TTL_MINUTES * 60 * 1000).toISOString(),
      attempts: 0
    });
    if (insertError) {
      // A parallel request already created this user's code (one open code per user), so the cooldown applies: no email
      if (insertError.code === UNIQUE_VIOLATION) return RESET_CODE_REQUESTED;
      logDatabaseError('Password reset insert error:', insertError);
      return RESET_CODE_REQUESTED;
    }

    await logUserActivity(user.id, 'password_reset_requested', 'Password reset code requested');

    // Not awaited: the reply takes about as long whether or not the email belongs to an account
    sendPasswordResetEmail(user, code);

    return RESET_CODE_REQUESTED;
  } catch (error) {
    console.error('Password reset request error:', error.message);
    return RESET_UNAVAILABLE;
  }
};

const resetPassword = async (req) => {
  try {
    const validation = validatePasswordReset(req.body);
    if (validation.error) return validation.error;

    const { normalizedEmail, resetCode, newPassword } = validation;
    const key = getConfiguredResetCodeKey();
    if (!key) return RESET_UNAVAILABLE;

    // Until the code is accepted, database errors get the same reply as an unknown account or a wrong code,
    // so a failing lookup can't reveal which email addresses have accounts
    const { data: users, error: userError } = await usersRepository.findByEmailForVerification(normalizedEmail);
    if (userError) {
      logDatabaseError('Password reset user lookup error:', userError);
      return INVALID_RESET_CODE;
    }

    const user = users && users[0];
    if (!user) return INVALID_RESET_CODE;

    // Count the attempt before checking the code, so parallel requests can't test more codes than allowed
    let reset = null;
    for (let tries = 0; tries < ATTEMPT_RESERVATION_TRIES && !reset; tries += 1) {
      const { data: rows, error: lookupError } = await passwordResetsRepository.findLatestByUserId(user.id);
      if (lookupError) {
        logDatabaseError('Password reset lookup error:', lookupError);
        return INVALID_RESET_CODE;
      }

      const latest = rows && rows[0];
      const now = new Date();
      const attempts = Number(latest && latest.attempts) || 0;
      if (!latest || latest.used_at || new Date(latest.expires_at) <= now || attempts >= PASSWORD_RESET_MAX_ATTEMPTS) {
        return INVALID_RESET_CODE;
      }

      const { data: reserved, error: reserveError } = await passwordResetsRepository.reserveAttempt(latest.id, attempts, now.toISOString());
      if (reserveError) {
        logDatabaseError('Password reset attempt error:', reserveError);
        return INVALID_RESET_CODE;
      }

      if (reserved && reserved.length > 0) {
        reset = { ...latest, attempts: attempts + 1 };
      }
    }

    if (!reset) return INVALID_RESET_CODE;

    if (!resetCodeMatches(key, user.id, resetCode, reset.reset_token)) {
      const locked = reset.attempts >= PASSWORD_RESET_MAX_ATTEMPTS;
      await logUserActivity(user.id, 'password_reset_code_failed', locked
        ? 'Incorrect password reset code; the code is now locked'
        : 'Incorrect password reset code');
      return INVALID_RESET_CODE;
    }

    const usedAt = new Date().toISOString();
    const { data: consumed, error: consumeError } = await passwordResetsRepository.consumeById(reset.id, usedAt);
    if (consumeError) {
      logDatabaseError('Password reset consume error:', consumeError);
      return RESET_UNAVAILABLE;
    }

    // Another request used or replaced this code first
    if (!consumed || consumed.length === 0) return INVALID_RESET_CODE;

    const { data: updatedUsers, error: updateError } = await usersRepository.updatePassword(user.id, newPassword);
    // Supabase reports no error when a policy blocks an update, so require a changed row
    if (!updateError && Array.isArray(updatedUsers) && updatedUsers.length > 0) {
      await logUserActivity(user.id, 'password_reset_completed', 'Password reset with an email code');
      return { statusCode: 200, body: { success: true, message: 'Your password has been reset. You can now log in with your new password.' } };
    }

    if (updateError) logDatabaseError('Password reset update error:', updateError);
    else console.error('Password reset update error: 0 rows updated', { user_id: user.id });

    // The password definitely did not change (rejected, or confirmed 0 rows), so this request gives its code back
    if (isDefiniteDatabaseRejection(updateError) || (!updateError && Array.isArray(updatedUsers))) {
      await logUserActivity(user.id, 'password_reset_failed', 'Password could not be updated');
      const { data: restored, error: restoreError } = await passwordResetsRepository.restoreConsumed(reset.id, usedAt);
      if (restoreError) logDatabaseError('Password reset restore error:', restoreError);
      if (!restoreError && restored && restored.length > 0) {
        return { statusCode: 500, body: { success: false, error: 'Could not reset your password. Please try again.' } };
      }
      return { statusCode: 500, body: { success: false, error: 'Could not reset your password. Please request a new code and try again.' } };
    }

    // The update may have been saved even though no confirmation arrived, so the code stays used and can't work twice
    console.error('Password reset update result unknown; the code stays used', { user_id: user.id });
    await logUserActivity(user.id, 'password_reset_failed', 'Password update could not be confirmed');
    return { statusCode: 500, body: { success: false, error: 'We could not confirm that your password was changed. Try logging in with your new password, or request a new code.' } };
  } catch (error) {
    console.error('Password reset error:', error.message);
    return RESET_UNAVAILABLE;
  }
};

module.exports = {
  requestPasswordReset,
  resetPassword
};
