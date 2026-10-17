require('./env'); // loads backend/.env into process.env, like the other config modules
const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');

// Server-only Supabase client for password reset and payment data
// (repositories/passwordResetsRepository.js and repositories/paymentsRepository.js only).
// It uses the service-role key, which bypasses RLS, so it must never be used by other repositories or reach the browser.
// There is deliberately no fallback to the anon key: without SUPABASE_SERVICE_KEY, password reset and deposit payments
// are unavailable, while the rest of the backend (shared client in config/supabase.js) keeps working.

let adminClient = null;

// The public anon/publishable key must never be used here, even if it is pasted into SUPABASE_SERVICE_KEY by mistake
function isPublicKey(key) {
  if (key === process.env.SUPABASE_ANON_KEY || key.startsWith('sb_publishable_')) return true;

  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role === 'anon';
  } catch (error) {
    return false;
  }
}

function readAdminConfig() {
  const url = process.env.SUPABASE_URL || '';
  const serviceKey = process.env.SUPABASE_SERVICE_KEY || '';
  return { url, serviceKey: serviceKey && !isPublicKey(serviceKey) ? serviceKey : '' };
}

function isSupabaseAdminConfigured() {
  const { url, serviceKey } = readAdminConfig();
  return Boolean(url && serviceKey);
}

// Created on first use, so a missing key never stops the server from starting
function getSupabaseAdmin() {
  if (adminClient) return adminClient;

  const { url, serviceKey } = readAdminConfig();
  if (!url || !serviceKey) {
    throw new Error('Server-only database access (password reset, payments) is not configured. Set SUPABASE_SERVICE_KEY (the service role key) on the server.');
  }

  adminClient = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  return adminClient;
}

if (process.env.SUPABASE_SERVICE_KEY && isPublicKey(process.env.SUPABASE_SERVICE_KEY)) {
  logger.warn('supabase.service_key_rejected', { reason: 'SUPABASE_SERVICE_KEY holds the public anon key', affects: 'password reset and payments only' });
} else if (!isSupabaseAdminConfigured()) {
  logger.warn('supabase.service_key_missing', { affects: 'password reset and payments only' });
}

module.exports = {
  getSupabaseAdmin,
  isSupabaseAdminConfigured
};
