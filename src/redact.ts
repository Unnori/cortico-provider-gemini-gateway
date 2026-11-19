/**
 * Masks an email address or account identifier by keeping only the first and
 * last character of the local part (before `@`), separated by three asterisks (`***`).
 *
 * Examples:
 * - `543213@gmail.com` -> `5***3@gmail.com`
 * - `alice@example.com` -> `a***e@example.com`
 * - `ab@gmail.com` -> `a***b@gmail.com`
 * - `a@gmail.com` -> `a***@gmail.com`
 */
export function maskEmail(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const at = trimmed.lastIndexOf('@');
  if (at > 0 && at < trimmed.length - 1) {
    const local = [...trimmed.slice(0, at)];
    const domain = trimmed.slice(at + 1);
    const maskedLocal = local.length >= 2
      ? `${local[0]}***${local[local.length - 1]}`
      : `${local[0]}***`;
    return `${maskedLocal}@${domain}`;
  }
  const chars = [...trimmed];
  return chars.length >= 2
    ? `${chars[0]}***${chars[chars.length - 1]}`
    : `${chars[0]}***`;
}
