import { z, type ZodTypeAny } from 'zod';
import { SEND_TIME_PATTERN } from '../reports/dailyReport.schema';

/**
 * Which settings an admin may write, and what each accepts.
 *
 * Most settings are deliberately unconstrained: their readers coerce the stored JSON and
 * fall back to a default, so a wrong type degrades to the default instead of breaking call
 * logging. The ones listed in `SETTING_VALUE_SCHEMAS` are different — a scheduler or a
 * screen depends on their exact shape, and a value the reader would silently discard
 * should be refused at the door with a sentence saying what is expected.
 */

/** The keys an admin may write. A closed list, so a typo creates an error, not a row. */
export const WRITABLE_SETTING_KEYS = [
  'recording.enabled',
  'recording.announce',
  'followup.reminder_minutes',
  'followup.overdue_alert_hours',
  'assignment.strategy',
  'calling.working_hours',
  'report.daily_email_enabled',
  'report.daily_email_time',
] as const;

export type WritableSettingKey = (typeof WRITABLE_SETTING_KEYS)[number];

const SWITCH_MESSAGE = 'This setting can only be switched on or off.';
const SEND_TIME_MESSAGE = 'Use 24-hour time as HH:MM, for example 08:00.';

/**
 * Per-key value schemas. A key absent from this map keeps accepting anything.
 *
 * The messages are written for the Settings screen, which shows a refused save's message
 * as it is — so they say what to type, not what failed.
 */
export const SETTING_VALUE_SCHEMAS: Partial<Record<WritableSettingKey, ZodTypeAny>> = {
  /*
   * A real boolean only. The reader would also take "true" and 1, but a save that sent
   * "yes" would read back as off — an admin who believes they switched the email on
   * must not be able to have switched it off by accident.
   */
  'report.daily_email_enabled': z.boolean({
    required_error: SWITCH_MESSAGE,
    invalid_type_error: SWITCH_MESSAGE,
  }),
  /*
   * Zero-padded 24-hour time. `7:30` is refused rather than guessed at: the value is
   * compared and displayed as text, and the time input on the Settings screen always
   * sends two digits.
   */
  'report.daily_email_time': z
    .string({ required_error: SEND_TIME_MESSAGE, invalid_type_error: SEND_TIME_MESSAGE })
    .trim()
    .regex(SEND_TIME_PATTERN, SEND_TIME_MESSAGE),
};

export type SettingValueCheck = { ok: true; value: unknown } | { ok: false; message: string };

/**
 * Checks a value against its key's schema. Returns the value to store — parsed, so a
 * trimmed time is stored trimmed — or the sentence explaining the refusal.
 */
export function checkSettingValue(key: WritableSettingKey, value: unknown): SettingValueCheck {
  const schema = SETTING_VALUE_SCHEMAS[key];
  if (!schema) return { ok: true, value };

  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data as unknown };

  return {
    ok: false,
    message: result.error.issues[0]?.message ?? 'That value is not valid for this setting.',
  };
}
