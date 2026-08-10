import { config } from '../../config/env';
import { badRequest } from '../../utils/httpError';
import { describeError, logger } from '../../utils/logger';
import { createReference, safeFilename, truncate } from '../../utils/text';
import { resolveStoredFile } from '../../middleware/upload';
import { sendAdminNotification, sendMail, type MailAttachment, type MailResult } from '../../services/mailer';
import {
  awaitDelivery,
  summariseDelivery,
  type DeliveryStatus,
} from '../../services/deliveryStatus';
import {
  jobApplicationAdminEmail,
  jobApplicationConfirmationEmail,
  type JobApplicationEmailData,
} from '../../services/email';
import {
  assertHumanVerified,
  screenSubmission,
  type SubmissionContext,
} from '../enquiries/enquiry.service';
import {
  countRecentByIp,
  insertApplication,
  markNotifications,
  type CreateApplicationData,
} from './application.repository';
import type { ApplicationInput } from './application.schema';

/** Applications are rarer than enquiries, so the per-IP ceiling is tighter. */
const MAX_PER_IP_PER_DAY = 5;

/**
 * Gmail refuses messages over 25 MB. Uploads are already capped well below that by
 * MAX_UPLOAD_MB, but base64 encoding inflates an attachment by roughly a third, so the
 * ceiling is checked against the encoded size rather than the file size.
 */
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

/**
 * How long the response waits for the two emails before reporting them as still in
 * flight. Comfortably longer than a healthy Gmail round trip, far shorter than the
 * socket timeout a wedged connection would otherwise impose on the applicant.
 */
const EMAIL_WAIT_MS = 12_000;

export type ResumeFile = {
  storedName: string;
  originalName: string;
  mimeType: string;
  size: number;
};

async function deliverApplicationEmails(
  id: number,
  data: JobApplicationEmailData,
  attachments: MailAttachment[],
): Promise<MailResult[]> {
  const notification = jobApplicationAdminEmail(data);
  const notificationResult = await sendAdminNotification({
    type: 'job-application-admin',
    subject: notification.subject,
    html: notification.html,
    text: notification.text,
    replyTo: data.email,
    attachments,
  });

  const confirmation = jobApplicationConfirmationEmail(data);
  const confirmationResult = await sendMail({
    type: 'job-application-confirmation',
    to: data.email,
    subject: confirmation.subject,
    html: confirmation.html,
    text: confirmation.text,
    // Replies from the applicant land in the same inbox that received the notification.
    ...(config.mail.adminRecipients[0] ? { replyTo: config.mail.adminRecipients[0] } : {}),
  });

  if (notificationResult !== 'sent' || confirmationResult !== 'sent') {
    logger.warn('Application stored but email delivery was incomplete', {
      reference: data.reference,
      notification: notificationResult,
      confirmation: confirmationResult,
    });
  }

  await markNotifications(id, {
    notificationSent: notificationResult === 'sent' || notificationResult === 'partial',
    autoReplySent: confirmationResult === 'sent',
  }).catch((error) => logger.warn('Could not record email status', describeError(error)));

  return [notificationResult, confirmationResult];
}

export async function createApplication(
  input: ApplicationInput,
  resume: ResumeFile | null,
  context: SubmissionContext,
): Promise<{ reference: string; id: number; emailStatus: DeliveryStatus }> {
  const verdict = screenSubmission(input);

  if (verdict.spam) {
    logger.warn('Application rejected as spam', { reason: verdict.reason, ip: context.ipAddress });
    throw badRequest('We could not process this submission. Please try again.');
  }

  await assertHumanVerified(input.recaptchaToken, context.ipAddress, 'application');

  if (context.ipAddress) {
    const recent = await countRecentByIp(context.ipAddress, 24 * 60).catch(() => 0);
    if (recent >= MAX_PER_IP_PER_DAY) {
      logger.warn('Application blocked by per-IP burst limit', { ip: context.ipAddress, recent });
      throw badRequest(
        'You have already submitted several applications. Please wait before submitting another.',
      );
    }
  }

  const reference = createReference('APP');
  const record: CreateApplicationData = {
    reference,
    fullName: input.fullName,
    email: input.email,
    phone: input.phone,
    position: input.position,
    message: input.message,
    linkedinUrl: input.linkedinUrl,
    portfolioUrl: input.portfolioUrl,
    experience: input.experience,
    location: input.location,
    resumeFilename: resume?.storedName ?? null,
    resumeOriginalName: resume ? safeFilename(resume.originalName) : null,
    resumeMime: resume?.mimeType ?? null,
    resumeSize: resume?.size ?? null,
    ipAddress: context.ipAddress,
    userAgent: truncate(context.userAgent, 255),
  };

  // The database write happens first and is the only step allowed to fail the request.
  // Everything after this point is best-effort: an SMTP outage must never lose an
  // application that the applicant has already been told was received.
  const id = await insertApplication(record);

  logger.info('Application stored', {
    reference,
    position: input.position,
    hasResume: Boolean(resume),
  });

  /**
   * The resume travels with the admin notification so reviewers can open it from the
   * inbox. The stored copy stays on disk, outside the web root, reachable only through
   * the authenticated admin download route — no public or guessable URL is ever
   * created or emailed.
   */
  const attachments: MailAttachment[] = [];

  if (resume && record.resumeOriginalName) {
    // resolveStoredFile returns null if the name would escape the upload directory.
    const storedPath = resolveStoredFile(resume.storedName);

    if (!storedPath) {
      logger.error('Stored resume path failed validation; not attaching', { reference });
    } else if (resume.size > MAX_ATTACHMENT_BYTES) {
      logger.warn('Resume too large to attach; admin will download it instead', {
        reference,
        size: resume.size,
      });
    } else {
      attachments.push({
        filename: record.resumeOriginalName,
        path: storedPath,
        contentType: resume.mimeType,
      });
    }
  }

  const emailData: JobApplicationEmailData = {
    reference,
    fullName: input.fullName,
    email: input.email,
    phone: input.phone,
    position: input.position,
    message: input.message,
    linkedinUrl: input.linkedinUrl,
    portfolioUrl: input.portfolioUrl,
    experience: input.experience,
    location: input.location,
    resumeOriginalName: record.resumeOriginalName,
    resumeAttached: attachments.length > 0,
    submittedAt: new Date(),
  };

  // Wait for delivery so the response can report what actually happened, but never
  // longer than EMAIL_WAIT_MS — a slow mail server must not hold up the applicant.
  const delivery = deliverApplicationEmails(id, emailData, attachments).catch((error) => {
    logger.error('Application email pipeline failed', { reference, ...describeError(error) });
    return ['failed', 'failed'] satisfies MailResult[];
  });

  const outcome = await awaitDelivery(delivery, EMAIL_WAIT_MS);
  const emailStatus: DeliveryStatus =
    outcome === 'timeout' ? 'pending' : summariseDelivery(outcome);

  if (emailStatus === 'pending') {
    logger.warn('Application email still in flight when the response was sent', { reference });
  }

  return { reference, id, emailStatus };
}
