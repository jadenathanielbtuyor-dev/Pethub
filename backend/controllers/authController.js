const supabase = require('../config/supabase');
const { sendEmail } = require('../utils/email');
const { generateVerificationCode, getExpiryTimestamp } = require('../utils/otp');

const isDev = process.env.NODE_ENV !== 'production';

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

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function normalizeEmail(value) {
  return hasValue(value) ? String(value).trim().toLowerCase() : '';
}

function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

function isVerifiedValue(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

async function logActivity(userId, action, details = '') {
  if (!hasValue(userId) || !hasValue(action)) return;
  try {
    await supabase.from('activity_logs').insert([
      {
        user_id: String(userId).trim(),
        action: String(action).trim(),
        details: String(details || '')
      }
    ]);
  } catch (error) {
    console.error('Activity log error:', error);
  }
}

const login = async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const normalizedEmail = normalizeEmail(email);
    const cleanPassword = hasValue(password) ? String(password) : '';

    if (!normalizedEmail || !cleanPassword) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    if (!isEmailLike(normalizedEmail)) {
      return res.status(400).json({ success: false, error: 'Enter a valid email address' });
    }

    const { data: users, error: queryError } = await supabase
      .from('users')
      .select('id, fullname, email, password, role, is_verified, created_at')
      .eq('email', normalizedEmail)
      .limit(1);

    if (queryError) {
      console.error('Query error:', queryError);
      return res.status(500).json({ success: false, error: 'Database error' });
    }

    if (!users || users.length === 0) {
      return res.status(403).json({ success: false, error: 'Invalid email or password' });
    }

    const user = users[0];

    if (!(await comparePassword(cleanPassword, user.password))) {
      return res.status(403).json({ success: false, error: 'Invalid email or password' });
    }

    if (Object.prototype.hasOwnProperty.call(user, 'is_verified')) {
      if (!isVerifiedValue(user.is_verified)) {
        return res.status(403).json({ success: false, error: 'Please verify your email first before logging in.' });
      }
    } else {
      const { data: verifiedRows, error: verificationError } = await supabase
        .from('email_verifications')
        .select('id')
        .eq('user_id', user.id)
        .eq('is_verified', true)
        .limit(1);

      if (verificationError) {
        console.error('Verification query error:', verificationError);
        return res.status(500).json({ success: false, error: 'Server error verifying account status' });
      }

      if (!verifiedRows || verifiedRows.length === 0) {
        return res.status(403).json({ success: false, error: 'Please verify your email first before logging in.' });
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

    await logActivity(user.id, 'user_logged_in', 'User logged in successfully');

    res.json({ success: true, message: 'Login successful', user: userResponse });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: 'Server error during login' });
  }
};

const register = async (req, res) => {
  try {
    const { fullname, email, password } = req.body || {};
    const cleanName = hasValue(fullname) ? String(fullname).trim() : '';
    const normalizedEmail = normalizeEmail(email);
    const cleanPassword = hasValue(password) ? String(password) : '';

    if (!cleanName || !normalizedEmail || !cleanPassword) {
      return res.status(400).json({ success: false, error: 'All fields are required' });
    }

    if (!isEmailLike(normalizedEmail)) {
      return res.status(400).json({ success: false, error: 'Enter a valid email address' });
    }

    const { data: existingUsers, error: checkError } = await supabase
      .from('users')
      .select('id')
      .eq('email', normalizedEmail);

    if (checkError) {
      console.error('Check existing user error:', checkError);
      return res.status(500).json({ success: false, error: 'Database error' });
    }

    if (existingUsers && existingUsers.length > 0) {
      return res.status(400).json({ success: false, error: 'Email already registered' });
    }

    const { data: newUsers, error: insertError } = await supabase
      .from('users')
      .insert([{ fullname: cleanName, email: normalizedEmail, password: cleanPassword, role: 'user', is_verified: false }])
      .select('id, fullname, email, role, is_verified, created_at');

    if (insertError) {
      console.error('Insert error:', insertError);
      const duplicateError = insertError.code === '23505' || /duplicate key|unique constraint|already exists/i.test(String(insertError.message || ''));
      if (duplicateError) {
        return res.status(400).json({ success: false, error: 'Email already registered' });
      }
      return res.status(500).json({ success: false, error: 'Failed to register user' });
    }

    if (!newUsers || newUsers.length === 0) {
      return res.status(500).json({ success: false, error: 'Registration failed' });
    }

    const user = newUsers[0];
    const verificationCode = generateVerificationCode();
    const expiresAt = getExpiryTimestamp();
    const { error: verificationError } = await supabase.from('email_verifications').insert([
      {
        user_id: user.id,
        verification_code: verificationCode,
        expires_at: expiresAt,
        is_verified: false
      }
    ]);

    if (verificationError) {
      console.error('Verification insert error:', verificationError);
      return res.status(500).json({ success: false, error: 'Failed to initialize email verification' });
    }

    const emailSubject = 'PetHub Verification Code';
    const emailText = `Hello ${cleanName},\n\nYour PetHub verification code is: ${verificationCode}\nIt will expire in 10 minutes.\n\nIf you did not register for PetHub, please ignore this message.`;
    const emailHtml = `
      <div style='font-family: Arial, sans-serif; color: #333;'>
        <h2 style='color: #f97316;'>PetHub Verification Code</h2>
        <p>Hello ${cleanName},</p>
        <p>Your PetHub verification code is:</p>
        <p style='font-size: 24px; font-weight: 700; letter-spacing: 4px; margin: 16px 0;'>${verificationCode}</p>
        <p>This code expires in 10 minutes.</p>
        <p>If you did not register for PetHub, please ignore this email.</p>
        <p>Thank you,<br/>The PetHub Team</p>
      </div>
    `;

    try {
      await sendEmail({ to: normalizedEmail, subject: emailSubject, text: emailText, html: emailHtml });
    } catch (error) {
      console.error('Send email error:', error);
      await logActivity(user.id, 'registration_email_failed', `Verification email could not be sent: ${error.message}`);
      const isRateLimited = /rate limited|421 4\.7\.32/i.test(error.message);
      return res.status(500).json({
        success: false,
        error: isRateLimited
          ? 'Email delivery is delayed. Please check back in a few minutes or use resend later.'
          : 'Registration created, but failed to send verification email. Please try resending the code.'
      });
    }

    await logActivity(user.id, 'user_registered', 'New user registered and verification email sent');

    res.status(201).json({
      success: true,
      message: 'User registered successfully. Verification code sent to email.',
      email: normalizedEmail
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ success: false, error: 'Server error during registration' });
  }
};

const verifyEmail = async (req, res) => {
  try {
    const { email, code } = req.body || {};
    const normalizedEmail = normalizeEmail(email);
    const verificationCode = hasValue(code) ? String(code).trim() : '';

    if (!normalizedEmail || !verificationCode) {
      return res.status(400).json({ success: false, error: 'Email and verification code are required' });
    }

    if (!isEmailLike(normalizedEmail)) {
      return res.status(400).json({ success: false, error: 'Enter a valid email address' });
    }

    const { data: users, error: userError } = await supabase
      .from('users')
      .select('id, fullname, email, is_verified')
      .eq('email', normalizedEmail)
      .limit(1);

    if (userError) {
      console.error('User query error:', userError);
      return res.status(500).json({ success: false, error: 'Database error' });
    }

    if (!users || users.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const user = users[0];

    const { data: verificationRows, error: verificationQueryError } = await supabase
      .from('email_verifications')
      .select('id, user_id, verification_code, expires_at, is_verified, created_at')
      .eq('user_id', user.id)
      .eq('is_verified', false)
      .order('created_at', { ascending: false })
      .limit(1);

    if (verificationQueryError) {
      console.error('Verification query error:', verificationQueryError);
      return res.status(500).json({ success: false, error: 'Server error verifying code' });
    }

    if (!verificationRows || verificationRows.length === 0) {
      const { data: alreadyVerified, error: alreadyVerifiedError } = await supabase
        .from('email_verifications')
        .select('id')
        .eq('user_id', user.id)
        .eq('is_verified', true)
        .limit(1);

      if (alreadyVerifiedError) {
        console.error('Already verified lookup error:', alreadyVerifiedError);
        return res.status(500).json({ success: false, error: 'Server error checking verification status' });
      }

      if (alreadyVerified && alreadyVerified.length > 0) {
        return res.json({ success: true, message: 'Email already verified.' });
      }

      return res.status(400).json({ success: false, error: 'No pending verification found. Please request a new code.' });
    }

    const verification = verificationRows[0];

    if (verification.verification_code !== verificationCode) {
      return res.status(400).json({ success: false, error: 'Invalid verification code' });
    }

    if (new Date(verification.expires_at) < new Date()) {
      return res.status(400).json({ success: false, error: 'Verification code has expired. Please request a new code.' });
    }

    const { error: updateError } = await supabase
      .from('email_verifications')
      .update({ is_verified: true })
      .eq('id', verification.id);

    if (updateError) {
      console.error('Verification update error:', updateError);
      return res.status(500).json({ success: false, error: 'Could not verify email' });
    }

    const { error: userUpdateError } = await supabase
      .from('users')
      .update({ is_verified: true })
      .eq('id', user.id);

    if (userUpdateError) {
      console.error('User is_verified update error:', userUpdateError);
      return res.status(500).json({ success: false, error: 'Could not update user verification status' });
    }

    await logActivity(user.id, 'email_verified', 'Email verification completed successfully');

    res.json({ success: true, message: 'Email verified successfully' });
  } catch (error) {
    console.error('Verify email error:', error);
    res.status(500).json({ success: false, error: 'Server error during email verification' });
  }
};

const resendVerificationCode = async (req, res) => {
  try {
    const { email } = req.body || {};
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }

    if (!isEmailLike(normalizedEmail)) {
      return res.status(400).json({ success: false, error: 'Enter a valid email address' });
    }

    const { data: users, error: userError } = await supabase
      .from('users')
      .select('id, fullname, email, is_verified')
      .eq('email', normalizedEmail)
      .limit(1);

    if (userError) {
      console.error('User query error:', userError);
      return res.status(500).json({ success: false, error: 'Database error' });
    }

    if (!users || users.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const user = users[0];

    if (isVerifiedValue(user.is_verified)) {
      return res.status(400).json({ success: false, error: 'Account is already verified. Please log in.' });
    }

    const { data: verifiedRows, error: verificationCheckError } = await supabase
      .from('email_verifications')
      .select('id')
      .eq('user_id', user.id)
      .eq('is_verified', true)
      .limit(1);

    if (verificationCheckError) {
      console.error('Verification status query error:', verificationCheckError);
      return res.status(500).json({ success: false, error: 'Unable to check verification status' });
    }

    if (verifiedRows && verifiedRows.length > 0) {
      return res.status(400).json({ success: false, error: 'Account is already verified. Please log in.' });
    }

    let verificationCode;
    let verificationRecord;

    const { data: existingRows, error: existingError } = await supabase
      .from('email_verifications')
      .select('id, user_id, verification_code, expires_at, is_verified, created_at')
      .eq('user_id', user.id)
      .eq('is_verified', false)
      .order('created_at', { ascending: false })
      .limit(1);

    if (existingError) {
      console.error('Existing verification lookup error:', existingError);
      return res.status(500).json({ success: false, error: 'Unable to prepare verification resend' });
    }

    if (existingRows && existingRows.length > 0) {
      const latestRow = existingRows[0];
      const secondsSinceLastSend = (Date.now() - new Date(latestRow.created_at).getTime()) / 1000;

      if (secondsSinceLastSend < 60) {
        return res.status(429).json({ success: false, error: 'Please wait at least 60 seconds before requesting a new verification code.' });
      }

      if (new Date(latestRow.expires_at) > new Date()) {
        verificationRecord = latestRow;
        verificationCode = latestRow.verification_code;
        const newExpiresAt = getExpiryTimestamp();

        const { error: updateError } = await supabase
          .from('email_verifications')
          .update({ expires_at: newExpiresAt })
          .eq('id', latestRow.id);

        if (updateError) {
          console.error('Resend expiry update error:', updateError);
        }

      } else {
        verificationCode = generateVerificationCode();
        const expiresAt = getExpiryTimestamp();
        const { data: insertedRows, error: insertError } = await supabase.from('email_verifications').insert([
          {
            user_id: user.id,
            verification_code: verificationCode,
            expires_at: expiresAt,
            is_verified: false
          }
        ]).select('id');

        if (insertError) {
          console.error('Resend insert error:', insertError);
          return res.status(500).json({ success: false, error: 'Could not create new verification code' });
        }

        verificationRecord = insertedRows && insertedRows[0];
      }
    } else {
      verificationCode = generateVerificationCode();
      const expiresAt = getExpiryTimestamp();
      const { data: insertedRows, error: insertError } = await supabase.from('email_verifications').insert([
        {
          user_id: user.id,
          verification_code: verificationCode,
          expires_at: expiresAt,
          is_verified: false
        }
      ]).select('id');

      if (insertError) {
        console.error('Resend insert error:', insertError);
        return res.status(500).json({ success: false, error: 'Could not create new verification code' });
      }

      verificationRecord = insertedRows && insertedRows[0];
    }

    const emailSubject = 'PetHub Verification Code';
    const emailText = `Hello ${user.fullname},\n\nYour PetHub verification code is: ${verificationCode}\nIt expires in 10 minutes.\n\nIf you did not request this code, please ignore this message.`;
    const emailHtml = `
      <div style='font-family: Arial, sans-serif; color: #333;'>
        <h2 style='color: #f97316;'>PetHub Verification Code</h2>
        <p>Hello ${user.fullname},</p>
        <p>Your PetHub verification code is:</p>
        <p style='font-size: 24px; font-weight: 700; letter-spacing: 4px; margin: 16px 0;'>${verificationCode}</p>
        <p>This code expires in 10 minutes.</p>
        <p>If you did not request this code, please ignore this email.</p>
        <p>Thank you,<br/>The PetHub Team</p>
      </div>
    `;

    try {
      await sendEmail({ to: normalizedEmail, subject: emailSubject, text: emailText, html: emailHtml });
    } catch (error) {
      console.error('Send email error:', error);
      await logActivity(user.id, 'verification_email_failed', `Resend verification email failed: ${error.message}`);
      const isRateLimited = /rate limited|421 4\.7\.32/i.test(error.message);
      return res.status(500).json({
        success: false,
        error: isRateLimited
          ? 'Email delivery is delayed. Please check back in a few minutes and try again.'
          : 'Failed to send verification email. Please try again.'
      });
    }

    await logActivity(user.id, 'verification_code_resent', 'Verification code resent to user');

    res.json({ success: true, message: 'Verification code resent to email' });
  } catch (error) {
    console.error('Resend code error:', error);
    res.status(500).json({ success: false, error: 'Server error while resending verification code' });
  }
};

const logout = async (req, res) => {
  try {
    const { userId } = req.body || {};
    const normalizedUserId = hasValue(userId) ? String(userId).trim() : '';

    if (!normalizedUserId) {
      return res.status(400).json({ success: false, error: 'User ID is required' });
    }

    await logActivity(normalizedUserId, 'user_logged_out', 'User logged out');

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ success: false, error: 'Server error during logout' });
  }
};

const getUserStatus = async (req, res) => {
  try {
    const userId = hasValue(req.query.user_id) ? String(req.query.user_id).trim() : '';
    if (!userId) {
      return res.status(400).json({ success: false, error: 'User ID is required' });
    }

    const { data: users, error: userError } = await supabase
      .from('users')
      .select('id, fullname, email, role, is_verified, created_at')
      .eq('id', userId)
      .limit(1);

    if (userError) {
      console.error('User status query error:', userError);
      return res.status(500).json({ success: false, error: 'Database error' });
    }

    if (!users || users.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const user = users[0];
    let isVerified = isVerifiedValue(user.is_verified);

    if (!isVerified) {
      const { data: verifiedRows, error: verificationError } = await supabase
        .from('email_verifications')
        .select('id')
        .eq('user_id', user.id)
        .eq('is_verified', true)
        .limit(1);

      if (verificationError) {
        console.error('Verification lookup error:', verificationError);
        return res.status(500).json({ success: false, error: 'Server error checking verification status' });
      }

      isVerified = Array.isArray(verifiedRows) && verifiedRows.length > 0;
    }

    res.json({
      success: true,
      user: {
        id: String(user.id),
        fullname: user.fullname,
        email: user.email,
        role: user.role,
        is_verified: isVerified,
        created_at: user.created_at
      }
    });
  } catch (error) {
    console.error('Get user status error:', error);
    res.status(500).json({ success: false, error: 'Server error retrieving user status' });
  }
};

const getActivityLogs = async (req, res) => {
  try {
    const userId = hasValue(req.query.user_id) ? String(req.query.user_id).trim() : '';
    if (!userId) {
      return res.status(400).json({ success: false, error: 'User ID is required' });
    }

    const { data: logs, error } = await supabase
      .from('activity_logs')
      .select('id, action, details, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      console.error('Activity logs query error:', error);
      return res.status(500).json({ success: false, error: 'Database error retrieving activity logs' });
    }

    res.json({ success: true, logs: logs || [] });
  } catch (error) {
    console.error('Get activity logs error:', error);
    res.status(500).json({ success: false, error: 'Server error retrieving activity logs' });
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
