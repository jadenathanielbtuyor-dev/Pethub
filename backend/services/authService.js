const { sendEmail } = require('../utils/email');
const { generateVerificationCode, getExpiryTimestamp } = require('../utils/otp');
const env = require('../config/env');
const { buildVerificationEmail } = require('../templates/email/verificationEmail');
const { logUserActivity } = require('../utils/activityLogger');
const { createAuthToken } = require('../utils/authToken');
const { hashPassword, verifyPassword, isPasswordHash } = require('../utils/passwordHash');
const logger = require('../utils/logger');
const { runExclusive } = require('../utils/keyedLock');
const { VERIFICATION_CODE_TTL_MINUTES, VERIFICATION_RESEND_COOLDOWN_SECONDS } = require('../constants/email');
const { PROFILE_COLUMNS } = require('../constants/userProfile');
const usersRepository = require('../repositories/usersRepository');
const emailVerificationsRepository = require('../repositories/emailVerificationsRepository');
const activityLogsRepository = require('../repositories/activityLogsRepository');
const {
  isVerifiedValue
} = require('../validators/commonValidator');
const {
  validateLogin,
  validateRegister,
  validateProfileUpdate,
  validateVerifyEmail,
  validateResendVerificationCode,
  validateRequiredUserId
} = require('../validators/authValidator');

const isDev = !env.isProduction;

const EMAIL_ALREADY_REGISTERED = { statusCode: 400, body: { success: false, error: 'Email already registered', field: 'email' } };

// PostgREST codes for a column the database does not have: the profile columns
// (database/migrations/2026-10-20_users_profile_fields.sql) have not been added yet
function isMissingColumnError(error) {
  return error?.code === 'PGRST204' || error?.code === '42703';
}

const PROFILE_COLUMNS_MISSING_LOG = 'the profile columns are missing from users; apply database/migrations/2026-10-20_users_profile_fields.sql';

// Checks the email and creates the account. Copies of one registration that arrive together (a double click,
// two tabs) run one at a time for that email in this process, so the second finds the first account; the
// database's duplicate-key error, when it reports one, covers requests handled elsewhere.
function createAccount({ cleanName, normalizedEmail, cleanPassword, profile }) {
  return runExclusive(`register:${normalizedEmail}`, async () => {
    const { data: existingUsers, error: checkError } = await usersRepository.findIdsByEmail(normalizedEmail);

    if (checkError) {
      console.error('Check existing user error:', checkError);
      return { response: { statusCode: 500, body: { success: false, error: 'Database error' } } };
    }

    if (existingUsers && existingUsers.length > 0) {
      return { response: EMAIL_ALREADY_REGISTERED };
    }

    const { data: newUsers, error: insertError } = await usersRepository.createUser({
      fullname: cleanName,
      email: normalizedEmail,
      password: await hashPassword(cleanPassword),
      role: 'user',
      is_verified: false,
      ...profile
    });

    if (insertError) {
      const duplicateError = insertError.code === '23505' || /duplicate key|unique constraint|already exists/i.test(String(insertError.message || ''));
      if (duplicateError) return { response: EMAIL_ALREADY_REGISTERED };

      // Nothing was saved: the account and its details are one insert
      if (isMissingColumnError(insertError)) {
        console.error(`Register error: ${PROFILE_COLUMNS_MISSING_LOG}`, { code: insertError.code });
        return { response: { statusCode: 503, body: {
          success: false,
          error: 'New accounts cannot be created right now while the clinic finishes an update. Please try again later.'
        } } };
      }

      console.error('Insert error:', { code: insertError.code, message: insertError.message });
      return { response: { statusCode: 500, body: { success: false, error: 'Failed to register user' } } };
    }

    if (!newUsers || newUsers.length === 0) {
      return { response: { statusCode: 500, body: { success: false, error: 'Registration failed' } } };
    }

    return { user: newUsers[0] };
  });
}

function pickProfile(row) {
  return Object.fromEntries(PROFILE_COLUMNS.map(column => [column, row[column] ?? null]));
}

// The signed-in customer's personal details for their dashboard (GET /auth/user-status?include=profile). Accounts
// created before these details were asked for have nulls until they complete them. null when they cannot be read, so
// the rest of the status reply still works (e.g. before the migration).
async function loadProfile(userId) {
  const { data, error } = await usersRepository.findProfileById(userId);
  if (error) {
    console.warn('User profile lookup error:', { code: error.code });
    return null;
  }

  const row = Array.isArray(data) ? data[0] : null;
  if (!row) return null;
  return pickProfile(row);
}

// Accounts created before hashing still hold their password as plaintext or sha256$<hex>: the first successful login
// replaces it with a scrypt hash. A failure here never blocks the login; the next login tries again.
async function upgradeStoredPassword(userId, password) {
  try {
    const { data, error } = await usersRepository.upgradeLegacyPassword(userId, await hashPassword(password));
    if (error) {
      console.warn('Password upgrade failed:', { code: error.code });
      return;
    }
    if (Array.isArray(data) && data.length > 0) logger.authEvent('password.upgraded', { user_id: String(userId) });
  } catch (error) {
    console.warn('Password upgrade failed:', error.message);
  }
}

const login = async (req) => {
  try {
    const validation = validateLogin(req.body);
    if (validation.error) return validation.error;

    const { normalizedEmail, cleanPassword } = validation;

    const { data: users, error: queryError } = await usersRepository.findByEmailForLogin(normalizedEmail);

    if (queryError) {
      console.error('Query error:', queryError);
      return { statusCode: 500, body: { success: false, error: 'Database error' } };
    }

    if (!users || users.length === 0) {
      return { statusCode: 403, body: { success: false, error: 'Invalid email or password' } };
    }

    const user = users[0];

    if (!(await verifyPassword(cleanPassword, user.password))) {
      return { statusCode: 403, body: { success: false, error: 'Invalid email or password' } };
    }

    if (!isPasswordHash(user.password)) await upgradeStoredPassword(user.id, cleanPassword);

    // Same rule as user-status and isUserVerified(): verified if the users flag is set OR the account
    // has a completed email verification record (only written after a correct, unexpired code).
    if (!isVerifiedValue(user.is_verified)) {
      const { data: verifiedRows, error: verificationError } = await emailVerificationsRepository.findVerifiedByUserId(user.id);

      if (verificationError) {
        console.error('Verification query error:', verificationError);
        return { statusCode: 500, body: { success: false, error: 'Server error verifying account status' } };
      }

      if (!verifiedRows || verifiedRows.length === 0) {
        return { statusCode: 403, body: { success: false, error: 'Please verify your email first before logging in.' } };
      }
    }

    const userResponse = {
      id: String(user.id),
      fullname: user.fullname,
      email: user.email,
      role: user.role,
      is_verified: true,
      created_at: user.created_at
    };

    let token;
    try {
      token = createAuthToken(user.id);
    } catch (tokenError) {
      console.error('Auth token error:', tokenError.message);
      return { statusCode: 500, body: { success: false, error: 'Login is temporarily unavailable. Please try again later.' } };
    }

    await logUserActivity(user.id, 'user_logged_in', 'User logged in successfully');

    return { statusCode: 200, body: { success: true, message: 'Login successful', user: userResponse, token } };
  } catch (error) {
    console.error('Login error:', error);
    return { statusCode: 500, body: { success: false, error: 'Server error during login' } };
  }
};

const register = async (req) => {
  try {
    const validation = validateRegister(req.body);
    if (validation.error) return validation.error;

    const { cleanName, normalizedEmail } = validation;

    const created = await createAccount(validation);
    if (created.response) return created.response;

    const user = created.user;
    const verificationCode = generateVerificationCode();
    const expiresAt = getExpiryTimestamp();
    const { error: verificationError } = await emailVerificationsRepository.createVerification({
      user_id: user.id,
      verification_code: verificationCode,
      expires_at: expiresAt,
      is_verified: false
    });

    if (verificationError) {
      console.error('Verification insert error:', verificationError);
      return { statusCode: 500, body: { success: false, error: 'Failed to initialize email verification' } };
    }

    const verificationEmail = buildVerificationEmail({
      name: cleanName,
      code: verificationCode,
      purpose: 'registration'
    });

    try {
      await sendEmail({ to: normalizedEmail, ...verificationEmail });
    } catch (error) {
      console.error('Send email error:', error);
      await logUserActivity(user.id, 'registration_email_failed', `Verification email could not be sent: ${error.message}`);
      const isRateLimited = /rate limited|421 4\.7\.32/i.test(error.message);
      return { statusCode: 500, body: {
        success: false,
        error: isRateLimited
          ? 'Email delivery is delayed. Please check back in a few minutes or use resend later.'
          : 'Registration created, but failed to send verification email. Please try resending the code.'
      } };
    }

    await logUserActivity(user.id, 'user_registered', 'New user registered and verification email sent');

    return { statusCode: 201, body: {
      success: true,
      message: 'User registered successfully. Verification code sent to email.',
      email: normalizedEmail
    } };
  } catch (error) {
    console.error('Register error:', error);
    return { statusCode: 500, body: { success: false, error: 'Server error during registration' } };
  }
};

const verifyEmail = async (req) => {
  try {
    const validation = validateVerifyEmail(req.body);
    if (validation.error) return validation.error;

    const { normalizedEmail, verificationCode } = validation;

    const { data: users, error: userError } = await usersRepository.findByEmailForVerification(normalizedEmail);

    if (userError) {
      console.error('User query error:', userError);
      return { statusCode: 500, body: { success: false, error: 'Database error' } };
    }

    if (!users || users.length === 0) {
      return { statusCode: 404, body: { success: false, error: 'User not found' } };
    }

    const user = users[0];

    const { data: verificationRows, error: verificationQueryError } = await emailVerificationsRepository.findLatestPendingByUserId(user.id);

    if (verificationQueryError) {
      console.error('Verification query error:', verificationQueryError);
      return { statusCode: 500, body: { success: false, error: 'Server error verifying code' } };
    }

    if (!verificationRows || verificationRows.length === 0) {
      const { data: alreadyVerified, error: alreadyVerifiedError } = await emailVerificationsRepository.findVerifiedByUserId(user.id);

      if (alreadyVerifiedError) {
        console.error('Already verified lookup error:', alreadyVerifiedError);
        return { statusCode: 500, body: { success: false, error: 'Server error checking verification status' } };
      }

      if (alreadyVerified && alreadyVerified.length > 0) {
        return { statusCode: 200, body: { success: true, message: 'Email already verified.' } };
      }

      return { statusCode: 400, body: { success: false, error: 'No pending verification found. Please request a new code.' } };
    }

    const verification = verificationRows[0];

    if (verification.verification_code !== verificationCode) {
      return { statusCode: 400, body: { success: false, error: 'Invalid verification code' } };
    }

    if (new Date(verification.expires_at) < new Date()) {
      return { statusCode: 400, body: { success: false, error: 'Verification code has expired. Please request a new code.' } };
    }

    const { data: verifiedRecordRows, error: updateError } = await emailVerificationsRepository.updateById(verification.id, { is_verified: true });

    if (updateError) {
      console.error('Verification update error:', updateError);
      return { statusCode: 500, body: { success: false, error: 'Could not verify email' } };
    }

    const { data: verifiedUserRows, error: userUpdateError } = await usersRepository.updateVerificationStatus(user.id, true);

    if (userUpdateError) {
      console.error('User is_verified update error:', userUpdateError);
      return { statusCode: 500, body: { success: false, error: 'Could not update user verification status' } };
    }

    // Supabase returns no error when a policy/permission blocks an update (0 rows changed),
    // so only report success if at least one verification marker was actually saved.
    const recordSaved = Array.isArray(verifiedRecordRows) && verifiedRecordRows.length > 0;
    const userFlagSaved = Array.isArray(verifiedUserRows) && verifiedUserRows.length > 0;
    if (!recordSaved && !userFlagSaved) {
      console.error('Email verification was not saved: 0 rows updated', { user_id: user.id });
      return { statusCode: 500, body: { success: false, error: 'Could not verify email' } };
    }
    if (!recordSaved || !userFlagSaved) {
      console.warn('Email verification partially saved', { user_id: user.id, record_saved: recordSaved, user_flag_saved: userFlagSaved });
    }

    await logUserActivity(user.id, 'email_verified', 'Email verification completed successfully');

    return { statusCode: 200, body: { success: true, message: 'Email verified successfully' } };
  } catch (error) {
    console.error('Verify email error:', error);
    return { statusCode: 500, body: { success: false, error: 'Server error during email verification' } };
  }
};

const resendVerificationCode = async (req) => {
  try {
    const validation = validateResendVerificationCode(req.body);
    if (validation.error) return validation.error;

    const { normalizedEmail } = validation;

    const { data: users, error: userError } = await usersRepository.findByEmailForVerification(normalizedEmail);

    if (userError) {
      console.error('User query error:', userError);
      return { statusCode: 500, body: { success: false, error: 'Database error' } };
    }

    if (!users || users.length === 0) {
      return { statusCode: 404, body: { success: false, error: 'User not found' } };
    }

    const user = users[0];

    if (isVerifiedValue(user.is_verified)) {
      return { statusCode: 400, body: { success: false, error: 'Account is already verified. Please log in.' } };
    }

    const { data: verifiedRows, error: verificationCheckError } = await emailVerificationsRepository.findVerifiedByUserId(user.id);

    if (verificationCheckError) {
      console.error('Verification status query error:', verificationCheckError);
      return { statusCode: 500, body: { success: false, error: 'Unable to check verification status' } };
    }

    if (verifiedRows && verifiedRows.length > 0) {
      return { statusCode: 400, body: { success: false, error: 'Account is already verified. Please log in.' } };
    }

    let verificationCode;
    let verificationRecord;

    const { data: existingRows, error: existingError } = await emailVerificationsRepository.findLatestPendingByUserId(user.id);

    if (existingError) {
      console.error('Existing verification lookup error:', existingError);
      return { statusCode: 500, body: { success: false, error: 'Unable to prepare verification resend' } };
    }

    if (existingRows && existingRows.length > 0) {
      const latestRow = existingRows[0];
      // A reused code keeps its created_at, but expires_at is reset to send time + TTL on every send
      const lastSentAt = Math.max(
        new Date(latestRow.created_at).getTime(),
        new Date(latestRow.expires_at).getTime() - VERIFICATION_CODE_TTL_MINUTES * 60 * 1000
      );
      const secondsSinceLastSend = (Date.now() - lastSentAt) / 1000;

      if (secondsSinceLastSend < VERIFICATION_RESEND_COOLDOWN_SECONDS) {
        return { statusCode: 429, body: { success: false, error: `Please wait at least ${VERIFICATION_RESEND_COOLDOWN_SECONDS} seconds before requesting a new verification code.` } };
      }

      if (new Date(latestRow.expires_at) > new Date()) {
        verificationRecord = latestRow;
        verificationCode = latestRow.verification_code;
        const newExpiresAt = getExpiryTimestamp();

        const { error: updateError } = await emailVerificationsRepository.updateById(latestRow.id, { expires_at: newExpiresAt });

        if (updateError) {
          console.error('Resend expiry update error:', updateError);
        }

      } else {
        verificationCode = generateVerificationCode();
        const expiresAt = getExpiryTimestamp();
        const { data: insertedRows, error: insertError } = await emailVerificationsRepository.createVerificationReturningId({
          user_id: user.id,
          verification_code: verificationCode,
          expires_at: expiresAt,
          is_verified: false
        });

        if (insertError) {
          console.error('Resend insert error:', insertError);
          return { statusCode: 500, body: { success: false, error: 'Could not create new verification code' } };
        }

        verificationRecord = insertedRows && insertedRows[0];
      }
    } else {
      verificationCode = generateVerificationCode();
      const expiresAt = getExpiryTimestamp();
      const { data: insertedRows, error: insertError } = await emailVerificationsRepository.createVerificationReturningId({
        user_id: user.id,
        verification_code: verificationCode,
        expires_at: expiresAt,
        is_verified: false
      });

      if (insertError) {
        console.error('Resend insert error:', insertError);
        return { statusCode: 500, body: { success: false, error: 'Could not create new verification code' } };
      }

      verificationRecord = insertedRows && insertedRows[0];
    }

    const verificationEmail = buildVerificationEmail({
      name: user.fullname,
      code: verificationCode,
      purpose: 'resend'
    });

    try {
      await sendEmail({ to: normalizedEmail, ...verificationEmail });
    } catch (error) {
      console.error('Send email error:', error);
      await logUserActivity(user.id, 'verification_email_failed', `Resend verification email failed: ${error.message}`);
      const isRateLimited = /rate limited|421 4\.7\.32/i.test(error.message);
      return { statusCode: 500, body: {
        success: false,
        error: isRateLimited
          ? 'Email delivery is delayed. Please check back in a few minutes and try again.'
          : 'Failed to send verification email. Please try again.'
      } };
    }

    await logUserActivity(user.id, 'verification_code_resent', 'Verification code resent to user');

    return { statusCode: 200, body: { success: true, message: 'Verification code resent to email' } };
  } catch (error) {
    console.error('Resend code error:', error);
    return { statusCode: 500, body: { success: false, error: 'Server error while resending verification code' } };
  }
};

const logout = async (req) => {
  try {
    const { userId } = req.body || {};
    const validation = validateRequiredUserId(userId);
    if (validation.error) return validation.error;

    const normalizedUserId = validation.userId;

    await logUserActivity(normalizedUserId, 'user_logged_out', 'User logged out');

    return { statusCode: 200, body: { success: true, message: 'Logged out successfully' } };
  } catch (error) {
    console.error('Logout error:', error);
    return { statusCode: 500, body: { success: false, error: 'Server error during logout' } };
  }
};

const getUserStatus = async (req) => {
  try {
    const validation = validateRequiredUserId(req.query.user_id);
    if (validation.error) return validation.error;

    const userId = validation.userId;

    const { data: users, error: userError } = await usersRepository.findStatusById(userId);

    if (userError) {
      console.error('User status query error:', userError);
      return { statusCode: 500, body: { success: false, error: 'Database error' } };
    }

    if (!users || users.length === 0) {
      return { statusCode: 404, body: { success: false, error: 'User not found' } };
    }

    const user = users[0];
    let isVerified = isVerifiedValue(user.is_verified);

    if (!isVerified) {
      const { data: verifiedRows, error: verificationError } = await emailVerificationsRepository.findVerifiedByUserId(user.id);

      if (verificationError) {
        console.error('Verification lookup error:', verificationError);
        return { statusCode: 500, body: { success: false, error: 'Server error checking verification status' } };
      }

      isVerified = Array.isArray(verifiedRows) && verifiedRows.length > 0;
    }

    const body = {
      success: true,
      user: {
        id: String(user.id),
        fullname: user.fullname,
        email: user.email,
        role: user.role,
        is_verified: isVerified,
        created_at: user.created_at
      }
    };

    // Only the user dashboard asks for the profile; it is kept apart from `user`, which the frontend stores in sessionStorage
    if (req.query.include === 'profile') {
      body.profile = await loadProfile(user.id);
    }

    return { statusCode: 200, body };
  } catch (error) {
    console.error('Get user status error:', error);
    return { statusCode: 500, body: { success: false, error: 'Server error retrieving user status' } };
  }
};

// PUT /auth/profile: the signed-in customer completes or corrects their own name and personal details. The account is
// the one in the verified token (req.authUserId), never an id from the body; email, password, role and verification
// status are refused by the validator.
const updateProfile = async (req) => {
  try {
    const validation = validateProfileUpdate(req.body);
    if (validation.error) return validation.error;

    const userId = String(req.authUserId || '').trim();
    if (!userId) return { statusCode: 401, body: { success: false, error: 'Authentication required. Please log in again.' } };

    const { data, error } = await usersRepository.updateProfile(userId, { fullname: validation.cleanName, ...validation.profile });

    if (error) {
      if (isMissingColumnError(error)) {
        console.error(`Profile update error: ${PROFILE_COLUMNS_MISSING_LOG}`, { code: error.code });
        return { statusCode: 503, body: { success: false, error: 'Your details cannot be saved right now while the clinic finishes an update. Please try again later.' } };
      }
      console.error('Profile update error:', { code: error.code });
      return { statusCode: 500, body: { success: false, error: 'Your details could not be saved. Please try again.' } };
    }

    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return { statusCode: 404, body: { success: false, error: 'Account not found' } };

    await logUserActivity(userId, 'profile_updated', 'Updated personal details');

    return { statusCode: 200, body: {
      success: true,
      message: 'Your details were saved.',
      user: {
        id: String(row.id),
        fullname: row.fullname,
        email: row.email,
        role: row.role,
        is_verified: isVerifiedValue(row.is_verified),
        created_at: row.created_at
      },
      profile: pickProfile(row)
    } };
  } catch (error) {
    console.error('Update profile error:', error.message);
    return { statusCode: 500, body: { success: false, error: 'Your details could not be saved. Please try again.' } };
  }
};

const getActivityLogs = async (req) => {
  try {
    const validation = validateRequiredUserId(req.query.user_id);
    if (validation.error) return validation.error;

    const userId = validation.userId;

    const { data: logs, error } = await activityLogsRepository.listUserActivityLogs(userId, 20);

    if (error) {
      console.error('Activity logs query error:', error);
      return { statusCode: 500, body: { success: false, error: 'Database error retrieving activity logs' } };
    }

    return { statusCode: 200, body: { success: true, logs: logs || [] } };
  } catch (error) {
    console.error('Get activity logs error:', error);
    return { statusCode: 500, body: { success: false, error: 'Server error retrieving activity logs' } };
  }
};

module.exports = {
  login,
  register,
  verifyEmail,
  resendVerificationCode,
  logout,
  getUserStatus,
  updateProfile,
  getActivityLogs
};
