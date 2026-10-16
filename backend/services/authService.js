const { sendEmail } = require('../utils/email');
const { generateVerificationCode, getExpiryTimestamp } = require('../utils/otp');
const env = require('../config/env');
const { buildVerificationEmail } = require('../templates/email/verificationEmail');
const { logUserActivity } = require('../utils/activityLogger');
const { createAuthToken } = require('../utils/authToken');
const { VERIFICATION_CODE_TTL_MINUTES, VERIFICATION_RESEND_COOLDOWN_SECONDS } = require('../constants/email');
const usersRepository = require('../repositories/usersRepository');
const emailVerificationsRepository = require('../repositories/emailVerificationsRepository');
const activityLogsRepository = require('../repositories/activityLogsRepository');
const {
  isVerifiedValue
} = require('../validators/commonValidator');
const {
  validateLogin,
  validateRegister,
  validateVerifyEmail,
  validateResendVerificationCode,
  validateRequiredUserId
} = require('../validators/authValidator');

const isDev = !env.isProduction;

function hashPasswordLegacy(password) {
  const crypto = require('crypto');
  return `sha256$${crypto.createHash('sha256').update(password, 'utf8').digest('hex')}`;
}

async function comparePassword(password, storedPassword) {
  if (!storedPassword) return false;
  if (storedPassword.startsWith('sha256$')) {
    return storedPassword === hashPasswordLegacy(password);
  }
  return String(password) === String(storedPassword);
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

    if (!(await comparePassword(cleanPassword, user.password))) {
      return { statusCode: 403, body: { success: false, error: 'Invalid email or password' } };
    }

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

    const { cleanName, normalizedEmail, cleanPassword } = validation;

    const { data: existingUsers, error: checkError } = await usersRepository.findIdsByEmail(normalizedEmail);

    if (checkError) {
      console.error('Check existing user error:', checkError);
      return { statusCode: 500, body: { success: false, error: 'Database error' } };
    }

    if (existingUsers && existingUsers.length > 0) {
      return { statusCode: 400, body: { success: false, error: 'Email already registered' } };
    }

    const { data: newUsers, error: insertError } = await usersRepository.createUser({
      fullname: cleanName,
      email: normalizedEmail,
      password: cleanPassword,
      role: 'user',
      is_verified: false
    });

    if (insertError) {
      console.error('Insert error:', insertError);
      const duplicateError = insertError.code === '23505' || /duplicate key|unique constraint|already exists/i.test(String(insertError.message || ''));
      if (duplicateError) {
        return { statusCode: 400, body: { success: false, error: 'Email already registered' } };
      }
      return { statusCode: 500, body: { success: false, error: 'Failed to register user' } };
    }

    if (!newUsers || newUsers.length === 0) {
      return { statusCode: 500, body: { success: false, error: 'Registration failed' } };
    }

    const user = newUsers[0];
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

    return { statusCode: 200, body: {
      success: true,
      user: {
        id: String(user.id),
        fullname: user.fullname,
        email: user.email,
        role: user.role,
        is_verified: isVerified,
        created_at: user.created_at
      }
    } };
  } catch (error) {
    console.error('Get user status error:', error);
    return { statusCode: 500, body: { success: false, error: 'Server error retrieving user status' } };
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
  getActivityLogs
};
