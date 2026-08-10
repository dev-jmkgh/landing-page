import { config } from '../../config/env';
import { badRequest } from '../../utils/httpError';
import { describeError, logger } from '../../utils/logger';
import { createReference, safeFilename, truncate } from '../../utils/text';
import { sendMail } from '../../services/mailer';
import {
  applicationAutoReply,
  applicationNotification,
  type ApplicationEmailData,
} from '../../services/emailTemplates';
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

export type ResumeFile = {
  storedName: string;
  originalName: string;
  mimeType: string;
  size: number;
};

async function deliverApplicationEmails(id: number, data: ApplicationEmailData): Promise<void> {
  const notification = applicationNotification(data);
  const notificationResult = await sendMail({
    to: config.mail.careersEmail,
    subject: notification.subject,
    html: notification.html,
    text: notification.text,
    replyTo: data.email,
  });

  const autoReply = applicationAutoReply(data);
  const autoReplyResult = await sendMail({
    to: data.email,
    subject: autoReply.subject,
    html: autoReply.html,
    text: autoReply.text,
    replyTo: config.mail.careersEmail,
  });

  if (notificationResult === 'failed' || autoReplyResult === 'failed') {
    logger.warn('Application stored but email delivery was incomplete', {
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

export async function createApplication(
  input: ApplicationInput,
  resume: ResumeFile | null,
  context: SubmissionContext,
): Promise<{ reference: string; id: number }> {
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
    resumeFilename: resume?.storedName ?? null,
    resumeOriginalName: resume ? safeFilename(resume.originalName) : null,
    resumeMime: resume?.mimeType ?? null,
    resumeSize: resume?.size ?? null,
    ipAddress: context.ipAddress,
    userAgent: truncate(context.userAgent, 255),
  };

  const id = await insertApplication(record);

  logger.info('Application stored', {
    reference,
    position: input.position,
    hasResume: Boolean(resume),
  });

  const emailData: ApplicationEmailData = {
    reference,
    fullName: input.fullName,
    email: input.email,
    phone: input.phone,
    position: input.position,
    message: input.message,
    resumeOriginalName: record.resumeOriginalName,
    submittedAt: new Date(),
  };

  void deliverApplicationEmails(id, emailData).catch((error) =>
    logger.error('Application email pipeline failed', { reference, ...describeError(error) }),
  );

  return { reference, id };
}
