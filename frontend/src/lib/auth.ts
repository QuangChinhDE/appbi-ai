/**
 * Auth utilities — client-side only.
 * JWT is decoded here WITHOUT signature verification (that's the middleware's job).
 */

export interface JwtPayload {
  sub: string;       // user UUID
  jti: string;
  iat: number;
  exp: number;
}

export interface CurrentUser {
  id: string;
  email: string;
  full_name: string;
  preferred_language: 'en' | 'vi';
  status: string;
  last_login_at: string | null;
  created_at: string;
}

/**
 * Decode (not verify) a JWT's payload from the `access_token` cookie.
 * The cookie is httpOnly so we can't read it directly from JS — instead
 * this is used when we have the raw token string (e.g. from SSR or explicit reads).
 *
 * For permission checks in React components, fetch /permissions/me instead.
 */
export function decodeJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload as JwtPayload;
  } catch {
    return null;
  }
}
