import { config } from '../../config/env';
import { badRequest } from '../../utils/httpError';
import { describeError, logger } from '../../utils/logger';
import { createReference, truncate } from '../../utils/text';
import { sendMail } from '../../services/mailer';
import { verifyRecaptcha } from '../../services/recaptcha';
import { enquiryAutoReply, enquiryNotification, type EnquiryEmailData } from '../../services/emailTemplates';
import {
  countRecentByIp,
  insertEnquiry,
  markNotifications,
  type CreateEnquiryData,
} from './enquiry.repository';
import type { EnquiryInput } from './enquiry.schema';

/**
 * Enquiry submission flow:
 *   1. Anti-spam checks (honeypot + submission timing + per-IP burst check)
 *   2. Store the enquiry — this is what determines success for the user
 *   3. Send the internal notification and the applicant auto-reply in the background
 *
 * Steps 2 and 3 are deliberately independent: an SMTP outage must never lose an
 * enquiry or show the visitor an error.
 */

/** A form completed faster than this was almost certainly not filled in by a person. */
const MIN_FILL_MILLISECONDS = 2_500;
/** Guards against a stale page being replayed hours later. */
const MAX_FORM_AGE_MILLISECONDS = 12 * 60 * 60 * 1000;
/** Additional per-IP burst ceiling, on top of the IP rate limiter. */
const MAX_PER_IP_PER_HOUR = 8;

export type SubmissionContext = {
  ipAddress: string | null;
  userAgent: string | undefined;
};

export type SpamVerdict = { spam: true; reason: string } | { spam: false };

/**
 * Verifies the reCAPTCHA token and throws a client-safe error if it does not hold up.
 *
 * Shared by the enquiry and application flows so both endpoints behave identically.
 * When Google itself is unreachable the submission is allowed through unless
 * RECAPTCHA_FAIL_CLOSED is set — an outage at Google should not cost the business a
 * genuine enquiry, and the honeypot, timing check and rate limits are still in force.
 */
export async function assertHumanVerified(
  token: string | undefined,
  ipAddress: string | null,
  formName: 'enquiry' | 'application',
): Promise<void> {
  const result = await verifyRecaptcha(token, ipAddress);
  if (result.ok) return;

  if (result.reason === 'unavailable' && !config.recaptcha.failClosed) {
    logger.warn('reCAPTCHA unavailable — allowing submission through', { form: formName, ip: ipAddress });
    return;
  }

  logger.warn('Submission failed reCAPTCHA', { form: formName, reason: result.reason, ip: ipAddress });

  throw badRequest(
    result.reason === 'missing_token'
      ? 'Please complete the "I am not a robot" verification and try again.'
      : 'Verification failed. Please complete the verification again and resubmit.',
    { recaptcha: 'Please complete the verification and try again.' },
  );
}

export function screenSubmission(
  input: { website?: string; renderedAt?: number },
  now = Date.now(),
): SpamVerdict {
  if (input.website && input.website.trim().length > 0) {
    return { spam: true, reason: 'honeypot' };
  }

  if (typeof input.renderedAt === 'number') {
    const elapsed = now - input.renderedAt;
    if (elapsed < MIN_FILL_MILLISECONDS) return { spam: true, reason: 'too_fast' };
    if (elapsed > MAX_FORM_AGE_MILLISECONDS) return { spam: true, reason: 'stale_form' };
  }

  return { spam: false };
}

async function deliverEnquiryEmails(id: number, data: EnquiryEmailData): Promise<void> {
  const notification = enquiryNotification(data);
  const notificationResult = await sendMail({
    to: config.mail.enquiryReceiver,
    subject: notification.subject,
    html: notification.html,
    text: notification.text,
    replyTo: data.email,
  });

  const autoReply = enquiryAutoReply(data);
  const autoReplyResult = await sendMail({
    to: data.email,
    subject: autoReply.subject,
    html: autoReply.html,
    text: autoReply.text,
    replyTo: config.mail.enquiryReceiver,
  });

  if (notificationResult === 'failed' || autoReplyResult === 'failed') {
    logger.warn('Enquiry stored but email delivery was incomplete', {
      reference: data.reference,
      notification: notificationResult,
      autoReply: autoReplyResult,
    });
  }

  await markNotifications(id, {
    notificationSent: notificationResult === 'sent',
    autoReplySent: autoReplyResult === 'sent',
  }).catch((error) => logger.warn('Could not record email status', describeError(error)));
}

export type CreateEnquiryResult = { reference: string; id: number };

export async function createEnquiry(
  input: EnquiryInput,
  context: SubmissionContext,
): Promise<CreateEnquiryResult> {
  const verdict = screenSubmission(input);

  if (verdict.spam) {
    logger.warn('Enquiry rejected as spam', { reason: verdict.reason, ip: context.ipAddress });
    // Deliberately vague: a bot learns nothing about which signal caught it.
    throw badRequest('We could not process this submission. Please try again.');
  }

  await assertHumanVerified(input.recaptchaToken, context.ipAddress, 'enquiry');

  if (context.ipAddress) {
    const recent = await countRecentByIp(context.ipAddress, 60).catch(() => 0);
    if (recent >= MAX_PER_IP_PER_HOUR) {
      logger.warn('Enquiry blocked by per-IP burst limit', { ip: context.ipAddress, recent });
      throw badRequest(
        'You have already sent several enquiries. Please wait a while before sending another.',
      );
    }
  }

  const reference = createReference('ENQ');
  const record: CreateEnquiryData = {
    reference,
    name: input.name,
    email: input.email,
    phone: input.phone,
    company: input.company,
    interestedIn: input.interestedIn,
    message: input.message,
    source: input.source,
    ipAddress: context.ipAddress,
    userAgent: truncate(context.userAgent, 255),
  };

  const id = await insertEnquiry(record);

  logger.info('Enquiry stored', { reference, interestedIn: input.interestedIn, source: input.source });

  const emailData: EnquiryEmailData = {
    reference,
    name: input.name,
    email: input.email,
    phone: input.phone,
    company: input.company,
    interestedIn: input.interestedIn,
    message: input.message,
    source: input.source,
    submittedAt: new Date(),
  };

  // Fire and forget: the visitor's response does not wait on SMTP.
  void deliverEnquiryEmails(id, emailData).catch((error) =>
    logger.error('Enquiry email pipeline failed', { reference, ...describeError(error) }),
  );

  return { reference, id };
}
