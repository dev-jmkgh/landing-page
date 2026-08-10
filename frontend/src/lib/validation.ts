import { FIELD_LIMITS, RESUME_UPLOAD } from '@/lib/constants';

/**
 * Client-side validation. This exists purely for fast, friendly feedback — the backend
 * repeats every one of these checks and is the only authority on what gets stored.
 */

export type ValidationResult = Record<string, string>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;
const PHONE_PATTERN = /^[+]?[\d\s()-]{7,20}$/;

export function validateRequired(value: string, label: string): string | null {
  return value.trim().length === 0 ? `${label} is required.` : null;
}

export function validateName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Please enter your name.';
  if (trimmed.length < FIELD_LIMITS.name.min) return 'Please enter your full name.';
  if (trimmed.length > FIELD_LIMITS.name.max)
    return `Name must be ${FIELD_LIMITS.name.max} characters or fewer.`;
  return null;
}

export function validateEmail(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Please enter your email address.';
  if (trimmed.length > FIELD_LIMITS.email.max) return 'Email address is too long.';
  if (!EMAIL_PATTERN.test(trimmed)) return 'Please enter a valid email address.';
  return null;
}

export function validatePhone(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Please enter your phone number.';
  if (!PHONE_PATTERN.test(trimmed)) return 'Please enter a valid phone number.';
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return 'Please enter a valid phone number.';
  return null;
}

export function validateCompany(value: string): string | null {
  if (value.trim().length > FIELD_LIMITS.company.max)
    return `Company name must be ${FIELD_LIMITS.company.max} characters or fewer.`;
  return null;
}

export function validateMessage(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Please tell us how we can help.';
  if (trimmed.length < FIELD_LIMITS.message.min)
    return `Please write at least ${FIELD_LIMITS.message.min} characters.`;
  if (trimmed.length > FIELD_LIMITS.message.max)
    return `Message must be ${FIELD_LIMITS.message.max} characters or fewer.`;
  return null;
}

export function validateSelection(value: string, label: string): string | null {
  return value.trim().length === 0 ? `Please choose ${label}.` : null;
}

export function validateResume(file: File | null, required = false): string | null {
  if (!file) return required ? 'Please attach your resume.' : null;

  if (file.size === 0) return 'The selected file appears to be empty.';
  if (file.size > RESUME_UPLOAD.maxSizeBytes)
    return `Resume must be ${RESUME_UPLOAD.maxSizeLabel} or smaller.`;

  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!RESUME_UPLOAD.acceptedExtensions.includes(extension as '.pdf' | '.doc' | '.docx'))
    return `Accepted formats: ${RESUME_UPLOAD.acceptedExtensions.join(', ')}.`;

  if (file.type && !RESUME_UPLOAD.acceptedMimeTypes.includes(file.type as 'application/pdf'))
    return `Accepted formats: ${RESUME_UPLOAD.acceptedExtensions.join(', ')}.`;

  if (file.name.length > 180) return 'Please shorten the file name and try again.';

  return null;
}

/** True when every value in the result object is an empty string / undefined. */
export function isValid(errors: ValidationResult): boolean {
  return Object.values(errors).every((message) => !message);
}
