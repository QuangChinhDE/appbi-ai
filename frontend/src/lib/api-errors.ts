const COMMON_PASSWORDS = new Set([
  'password',
  '123456',
  '12345678',
  'qwerty',
  'abc123',
  'monkey',
  'master',
  'dragon',
  '111111',
  'baseball',
  'iloveyou',
  'trustno1',
  'sunshine',
  'princess',
  'welcome',
  'shadow',
  'superman',
  'michael',
  'football',
  'password1',
  'password123',
  'admin',
  'letmein',
  '1234567',
  '123456789',
  '12345',
  '1234567890',
  '0987654321',
  '000000',
  '654321',
  'qwerty123',
  'admin123',
  'admin1234',
  'passw0rd',
  'p@ssw0rd',
  'p@ssword',
]);

export const PASSWORD_REQUIREMENTS_TEXT =
  'Use at least 8 characters with uppercase, lowercase, number, and special character.';

function normalizeValidationMessage(message: string): string {
  return message.replace(/^Value error,\s*/i, '').trim();
}

function formatValidationLocation(loc: unknown): string {
  if (!Array.isArray(loc)) return '';
  const path = loc
    .filter((part): part is string => typeof part === 'string' && part !== 'body')
    .join('.');
  return path ? `${path}: ` : '';
}

function extractDetailMessage(detail: unknown): string | null {
  if (typeof detail === 'string') return detail;

  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => {
        if (typeof item === 'string') return normalizeValidationMessage(item);
        if (!item || typeof item !== 'object') return null;

        const record = item as Record<string, unknown>;
        const baseMessage =
          typeof record.msg === 'string'
            ? normalizeValidationMessage(record.msg)
            : typeof record.message === 'string'
              ? record.message
              : null;

        if (!baseMessage) return null;
        return `${formatValidationLocation(record.loc)}${baseMessage}`;
      })
      .filter((message): message is string => Boolean(message));

    if (messages.length) {
      return [...new Set(messages)].join('; ');
    }
  }

  if (detail && typeof detail === 'object') {
    const record = detail as Record<string, unknown>;
    if (typeof record.message === 'string' && typeof record.code === 'string') {
      return `${record.message} (${record.code})`;
    }
    if (typeof record.message === 'string') return record.message;
    if (typeof record.detail === 'string') return record.detail;
    if (typeof record.error === 'string') return record.error;
  }

  if (typeof detail === 'number' || typeof detail === 'boolean') {
    return String(detail);
  }

  return null;
}

export function extractApiError(error: unknown, fallback = 'An error occurred.'): string {
  if (error && typeof error === 'object') {
    const record = error as Record<string, any>;
    const detailMessage = extractDetailMessage(record.response?.data?.detail);
    if (detailMessage) return detailMessage;

    const dataMessage = extractDetailMessage(record.response?.data);
    if (dataMessage) return dataMessage;

    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message;
    }
  }

  return fallback;
}

export function validatePasswordStrength(password: string): string | null {
  const errors: string[] = [];

  if (password.length < 8) errors.push('at least 8 characters');
  if (!/[A-Z]/.test(password)) errors.push('at least 1 uppercase letter');
  if (!/[a-z]/.test(password)) errors.push('at least 1 lowercase letter');
  if (!/\d/.test(password)) errors.push('at least 1 digit');
  if (!/[^A-Za-z0-9]/.test(password)) errors.push('at least 1 special character');
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    errors.push('must not be a commonly used password');
  }

  if (!errors.length) return null;
  return `Password must contain: ${errors.join(', ')}`;
}
