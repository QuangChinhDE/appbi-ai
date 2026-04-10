export type AuthProvider = 'password' | 'google';

export const authConfig = {
  passwordEnabled: process.env.NEXT_PUBLIC_AUTH_PASSWORD_LOGIN_ENABLED !== 'false',
  googleEnabled: process.env.NEXT_PUBLIC_AUTH_GOOGLE_ENABLED === 'true',
  googleClientId: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '',
};

export function getAuthMethodLabel(
  provider: AuthProvider,
  googleConnected = false,
): string {
  if (provider === 'google') {
    return googleConnected ? 'Google' : 'Google (pending first sign-in)';
  }
  return 'Password';
}
