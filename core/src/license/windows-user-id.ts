import os from 'node:os';

/** Normalize AD account for license binding: DOMAIN\user (uppercase). */
export function normalizeUserHint(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  if (s.includes('\\')) {
    const [domain, user] = s.split('\\', 2);
    return `${domain.trim()}\\${user.trim()}`.toUpperCase();
  }
  if (s.includes('@')) {
    const [user, domain] = s.split('@', 2);
    return `${domain.trim()}\\${user.trim()}`.toUpperCase();
  }
  return s.toUpperCase();
}

/** Current Windows logon (USERDOMAIN\USERNAME). */
export function computeWindowsUserId(): string {
  const domain = process.env.USERDOMAIN?.trim() || '';
  const user = process.env.USERNAME?.trim() || os.userInfo().username.trim();
  if (domain && domain.toUpperCase() !== user.toUpperCase()) {
    return normalizeUserHint(`${domain}\\${user}`);
  }
  return normalizeUserHint(user);
}
