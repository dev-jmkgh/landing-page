import crypto from 'node:crypto';

/** Text helpers shared by validation, storage and email rendering. */

/** Control characters that have no legitimate place in a submitted form field. */
const CONTROL_CHARACTERS = new RegExp('[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]', 'g');

/** Normalises line endings and strips control characters. */
export function normaliseText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(CONTROL_CHARACTERS, '').trim();
}

/** Single-line fields additionally collapse internal whitespace runs. */
export function normaliseLine(value: string): string {
  return normaliseText(value).replace(/\s+/g, ' ');
}

/**
 * Escapes user-supplied text before it is placed into an HTML email body.
 * Emails are the one place we render user input as markup, so this is not optional.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escapes and converts newlines to `<br />` for HTML email bodies. */
export function escapeHtmlMultiline(value: string): string {
  return escapeHtml(value).replace(/\n/g, '<br />');
}

/**
 * Header injection guard: strips CR/LF from anything that ends up in a mail header
 * (subject lines, display names).
 */
export function sanitiseHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** Ambiguous characters (0/O, 1/I) are omitted so references can be read aloud. */
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Human-quotable reference, e.g. `ENQ-7KQ4M2XP`. Random rather than sequential so a
 * reference never leaks how many records exist.
 */
export function createReference(prefix: 'ENQ' | 'APP'): string {
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (const byte of bytes) {
    code += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  }
  return `${prefix}-${code}`;
}

/** Truncates a value to a column's length so a long user-agent can never break an insert. */
export function truncate(value: string | undefined, maxLength: number): string | null {
  if (!value) return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

/**
 * Strips directory components and dangerous characters from an uploaded file name.
 * The name used on disk is always generated separately — this is kept for display only.
 */
export function safeFilename(original: string): string {
  const base = original.replace(/\\/g, '/').split('/').pop() ?? 'file';
  return base
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/_{2,}/g, '_')
    .slice(0, 180)
    .trim();
}
