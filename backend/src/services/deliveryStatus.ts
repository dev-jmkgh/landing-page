import type { MailResult } from './mailer';

/**
 * How a submission's notifications actually went, as reported back to the browser.
 *
 * The database write always happens first and is the only step that can fail the
 * request. This type exists so the response can then tell the truth about the email:
 * claiming "we have emailed you" when Gmail refused the message is the specific
 * dishonesty this replaces.
 */
export type DeliveryStatus = 'sent' | 'partial' | 'pending' | 'failed' | 'skipped';

/**
 * Waits for delivery, but not forever.
 *
 * A wedged SMTP connection can sit for the length of the socket timeout, which is far
 * longer than anyone should wait on a form submission. If delivery has not finished in
 * time the send keeps running in the background and the caller reports 'pending' —
 * accurate, because the message really is still on its way.
 */
export async function awaitDelivery<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    // Do not hold the process open just for this timer.
    timer.unref?.();
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Collapses the individual send outcomes into the status reported to the client. */
export function summariseDelivery(results: MailResult[]): DeliveryStatus {
  if (results.length === 0) return 'skipped';
  if (results.every((result) => result === 'skipped')) return 'skipped';

  const attempted = results.filter((result) => result !== 'skipped');
  if (attempted.every((result) => result === 'sent')) return 'sent';
  if (attempted.every((result) => result === 'failed')) return 'failed';
  return 'partial';
}

/**
 * The message shown to the visitor.
 *
 * Every variant confirms that the submission itself was stored, because it was — an
 * email problem must never read as "your application was lost".
 */
export function deliveryMessage(
  status: DeliveryStatus,
  kind: 'enquiry' | 'application',
): string {
  const stored =
    kind === 'enquiry'
      ? 'Thank you! Your enquiry has been received'
      : 'Thank you! Your application has been received';

  switch (status) {
    case 'sent':
      return `${stored} successfully. Our team will review it and get back to you shortly.`;
    case 'partial':
    case 'failed':
      return (
        `${stored} and saved successfully. We had a problem sending the confirmation email, ` +
        'but our team can still see your details and will get back to you.'
      );
    case 'pending':
      return `${stored} successfully and the confirmation email is on its way.`;
    case 'skipped':
    default:
      return `${stored} successfully. Our team will review it and get back to you shortly.`;
  }
}
