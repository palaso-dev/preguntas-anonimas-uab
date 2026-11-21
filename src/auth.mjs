import crypto from 'node:crypto';

export const ADMIN_COOKIE_NAME = 'gala_admin';
export const PRESENTER_COOKIE_NAME = 'gala_presenter';
const SESSION_MAX_AGE_SECONDS = 86400;
const MIN_SUBMIT_INTERVAL_MS = 4000;
const WINDOW_DURATION_MS = 60000;
const MAX_SUBMISSIONS_PER_WINDOW = 6;

const rateBuckets = new Map();

export function parseCookies(cookieHeader) {
  const cookies = {};
  if (typeof cookieHeader !== 'string' || !cookieHeader) {
    return cookies;
  }
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const eqIndex = part.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }
    const name = part.slice(0, eqIndex).trim();
    const rawValue = part.slice(eqIndex + 1).trim();
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }
  return cookies;
}

export function safeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function signToken(role, sessionSecret) {
  const timestamp = String(Date.now());
  const payload = `${role}:${timestamp}`;
  const signature = crypto
    .createHmac('sha256', sessionSecret)
    .update(payload)
    .digest('hex');
  return `${timestamp}.${signature}`;
}

function verifyToken(token, role, sessionSecret) {
  if (typeof token !== 'string' || typeof sessionSecret !== 'string' || !sessionSecret) {
    return false;
  }
  const dotIndex = token.indexOf('.');
  if (dotIndex <= 0) {
    return false;
  }
  const timestamp = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);
  if (!/^\d+$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }
  const issuedAt = Number(timestamp);
  if (!Number.isFinite(issuedAt)) {
    return false;
  }
  const ageMs = Date.now() - issuedAt;
  if (ageMs < -60000 || ageMs > SESSION_MAX_AGE_SECONDS * 1000) {
    return false;
  }
  const expectedSignature = crypto
    .createHmac('sha256', sessionSecret)
    .update(`${role}:${timestamp}`)
    .digest('hex');
  return safeEqualStrings(signature.toLowerCase(), expectedSignature);
}

export function isHttpsRequest(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return forwardedProto === 'https' || Boolean(req.socket?.encrypted);
}

export function buildCookieHeader(name, value, req, maxAge = SESSION_MAX_AGE_SECONDS) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAge}`,
  ];
  if (isHttpsRequest(req)) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function createAdminCookie(req, settings) {
  const token = signToken('admin', settings.session_secret);
  return buildCookieHeader(ADMIN_COOKIE_NAME, token, req);
}

export function clearAdminCookie(req) {
  return buildCookieHeader(ADMIN_COOKIE_NAME, '', req, 0);
}

export function createPresenterCookie(req, settings) {
  const token = signToken('presenter', settings.session_secret);
  return buildCookieHeader(PRESENTER_COOKIE_NAME, token, req);
}

export function clearPresenterCookie(req) {
  return buildCookieHeader(PRESENTER_COOKIE_NAME, '', req, 0);
}

export function isAdminRequest(req, settings) {
  const cookies = parseCookies(req.headers.cookie);
  return verifyToken(cookies[ADMIN_COOKIE_NAME], 'admin', settings.session_secret);
}

export function hasMatchingPresenterToken(req, settings) {
  const expectedToken = settings.presenter_token || '';
  if (!expectedToken) {
    return false;
  }
  const headerToken = req.headers['x-presenter-token'];
  if (typeof headerToken === 'string' && safeEqualStrings(headerToken.trim(), expectedToken)) {
    return true;
  }
  try {
    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    const queryToken = parsedUrl.searchParams.get('k');
    if (typeof queryToken === 'string' && safeEqualStrings(queryToken.trim(), expectedToken)) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function isPresenterRequest(req, settings) {
  if (isAdminRequest(req, settings)) {
    return true;
  }
  const cookies = parseCookies(req.headers.cookie);
  if (verifyToken(cookies[PRESENTER_COOKIE_NAME], 'presenter', settings.session_secret)) {
    return true;
  }
  return hasMatchingPresenterToken(req, settings);
}

export function getClientIp(req) {
  const cfIp = req.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.trim()) {
    return cfIp.trim();
  }
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

export function checkSubmissionRateLimit(req) {
  const now = Date.now();
  if (rateBuckets.size > 500) {
    for (const [key, timestamps] of rateBuckets.entries()) {
      const fresh = timestamps.filter((t) => now - t < WINDOW_DURATION_MS);
      if (fresh.length === 0) {
        rateBuckets.delete(key);
      } else {
        rateBuckets.set(key, fresh);
      }
    }
  }

  const ip = getClientIp(req);
  const existing = (rateBuckets.get(ip) || []).filter((t) => now - t < WINDOW_DURATION_MS);

  if (existing.length > 0) {
    const lastTimestamp = existing[existing.length - 1];
    const elapsed = now - lastTimestamp;
    if (elapsed < MIN_SUBMIT_INTERVAL_MS) {
      const retryAfterSeconds = Math.max(1, Math.ceil((MIN_SUBMIT_INTERVAL_MS - elapsed) / 1000));
      return {
        allowed: false,
        retryAfterSeconds,
        message: `Espera ${retryAfterSeconds} segundos antes de enviar otra confesión.`,
      };
    }
  }

  if (existing.length >= MAX_SUBMISSIONS_PER_WINDOW) {
    const oldest = existing[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((WINDOW_DURATION_MS - (now - oldest)) / 1000));
    return {
      allowed: false,
      retryAfterSeconds,
      message: `Has enviado varios mensajes seguidos. Intenta de nuevo en ${retryAfterSeconds} segundos.`,
    };
  }

  existing.push(now);
  rateBuckets.set(ip, existing);
  return { allowed: true, retryAfterSeconds: 0, message: '' };
}
