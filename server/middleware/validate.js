/**
 * Validate that a route param is a positive integer.
 * Returns the parsed integer or sends a 400 and returns null.
 */
export function requireIntParam(req, res, paramName) {
  const raw = req.params[paramName];
  if (!/^\d+$/.test(raw)) {
    res.status(400).json({ error: `Invalid ${paramName}: must be a positive integer` });
    return null;
  }
  return parseInt(raw, 10);
}

/**
 * Validate text length. Returns true if valid, false if it sent an error response.
 */
export function requireMaxLength(res, value, maxLength, fieldName) {
  if (typeof value === 'string' && value.length > maxLength) {
    res.status(400).json({ error: `${fieldName} must be ${maxLength} characters or fewer` });
    return false;
  }
  return true;
}

/**
 * Validate password complexity.
 * Returns null if valid, or an error message string if invalid.
 */
export function validatePassword(password) {
  if (!password || typeof password !== 'string') {
    return 'Password is required';
  }
  if (password.length < 8 || password.length > 128) {
    return 'Password must be 8-128 characters';
  }
  if (!/[a-z]/.test(password)) {
    return 'Password must contain at least one lowercase letter';
  }
  if (!/[A-Z]/.test(password)) {
    return 'Password must contain at least one uppercase letter';
  }
  if (!/[0-9]/.test(password)) {
    return 'Password must contain at least one digit';
  }
  return null;
}

/**
 * Limit JSON body size middleware (applied globally in index.js).
 * express.json({ limit }) handles this, but this is an extra safety net.
 */
export const MAX_BODY_SIZE = '512kb';
