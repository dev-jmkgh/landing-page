import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config/env';
import { describeError, logger } from '../utils/logger';
import { sanitiseHeaderValue } from '../utils/text';

/**
 * Gmail SMTP transport.
 *
 * Credentials come from the environment only — SMTP_USER must be a Gmail account and
 * SMTP_PASSWORD a Gmail **App Password**, never the account password. If either is
 * missing, email is disabled and the API continues to validate and store submissions;
 * a failed notification never fails the user's request.
 */

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!config.smtp.enabled) return null;
  if (transporter) return transporter;

  // Port 465 is implicit TLS; 587 is STARTTLS on a plain connection. Getting the
  // pairing wrong makes Gmail hang until the connection times out, which looks like
  // "email silently does nothing", so the mismatch is reported loudly at startup.
  if (config.smtp.port === 465 && !config.smtp.secure) {
    logger.warn('SMTP_PORT 465 requires SMTP_SECURE=true (implicit TLS). Connection will likely fail.');
  }
  if (config.smtp.port === 587 && config.smtp.secure) {
    logger.warn('SMTP_PORT 587 requires SMTP_SECURE=false (STARTTLS). Connection will likely fail.');
  }

  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    // Ask for STARTTLS explicitly on the submission port; harmless on 465.
    requireTLS: !config.smtp.secure,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.password,
    },
    pool: true,
    maxConnections: 2,
    maxMessages: 50,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  return transporter;
}

/**
 * The effective mail configuration, for diagnostics.
 *
 * Deliberately reports whether the password is *present*, never its value or length —
 * enough to tell "the variable never reached the process" apart from "Gmail rejected
 * the credentials", which are the two failures that look identical from the outside.
 */
export function mailConfigReport() {
  return {
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    user: config.smtp.user ? maskEmail(config.smtp.user) : '(empty)',
    passwordConfigured: config.smtp.password.length > 0,
    from: config.smtp.fromEmail ? maskEmail(config.smtp.fromEmail) : '(empty)',
    enabled: config.smtp.enabled,
    adminRecipientCount: config.mail.adminRecipients.length,
    adminRecipients: config.mail.adminRecipients.map(maskEmail),
  };
}

/** Verifies SMTP credentials at startup. Logs the outcome; never throws. */
export async function verifyMailer(): Promise<boolean> {
  const transport = getTransporter();

  if (!transport) {
    logger.warn(
      'SMTP is not configured (SMTP_USER / SMTP_PASSWORD are empty). ' +
        'Enquiries will be stored but no email will be sent.',
      mailConfigReport(),
    );
    return false;
  }

  if (config.mail.adminRecipients.length === 0) {
    logger.error(
      'SMTP is configured but ADMIN_EMAILS is empty — notifications have nowhere to go.',
    );
  }

  /**
   * A From address on a different domain to the authenticated account is the most
   * common reason mail "sends successfully" and is never seen: Gmail accepts it, but
   * the receiving server finds no SPF/DKIM authorisation for that domain, DMARC fails,
   * and the message is filed as spam. The send reports 250 OK either way, so nothing
   * downstream can detect this — hence the warning here.
   */
  const fromDomain = config.smtp.fromEmail.split('@')[1]?.toLowerCase();
  const authDomain = config.smtp.user.split('@')[1]?.toLowerCase();

  if (fromDomain && authDomain && fromDomain !== authDomain) {
    logger.warn(
      `SMTP_FROM_EMAIL is on "${fromDomain}" but the authenticated account is on "${authDomain}". ` +
        'Gmail will accept the message, but receiving servers are likely to treat it as spoofed ' +
        'and file it as spam. Either leave SMTP_FROM_EMAIL blank (send as the authenticated ' +
        'account) or make that address a verified alias on it. Replies still go to the business ' +
        'address via Reply-To.',
      { from: maskEmail(config.smtp.fromEmail), account: maskEmail(config.smtp.user) },
    );
  }

  try {
    await transport.verify();
    // The full effective config goes in the success line too, so a working startup
    // still shows which account and how many recipients are actually in play.
    logger.info('SMTP connection verified', mailConfigReport());
    return true;
  } catch (error) {
    // Log the failure category and the configuration, never the credentials.
    logger.error('SMTP verification failed', {
      ...mailConfigReport(),
      ...describeError(error),
      hint:
        'For Gmail, SMTP_PASSWORD must be a 16-character App Password (Google Account > ' +
        'Security > 2-Step Verification > App passwords), not the account password.',
    });
    return false;
  }
}

function maskEmail(email: string): string {
  const [name = '', domain = ''] = email.split('@');
  if (!domain) return '***';
  return `${name.slice(0, 2)}***@${domain}`;
}

export type MailAttachment = {
  filename: string;
  /** File on disk. Streamed by nodemailer; never read into memory here. */
  path: string;
  contentType?: string;
};

export type MailInput = {
  /** One address or several. Several are delivered as a single message. */
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  attachments?: MailAttachment[];
  /** Short identifier used in the logs, e.g. 'enquiry-admin'. */
  type?: string;
};

/**
 * 'sent'    — the SMTP server accepted the message for at least one recipient.
 * 'partial' — accepted for some recipients and refused for others.
 * 'skipped' — email is not configured; nothing was attempted.
 * 'failed'  — refused for every recipient, or the connection itself failed.
 */
export type MailResult = 'sent' | 'partial' | 'skipped' | 'failed';

/**
 * Sends a message. Returns the outcome rather than throwing, so callers can record
 * whether a notification succeeded without failing the user's submission.
 */
export async function sendMail(input: MailInput): Promise<MailResult> {
  const transport = getTransporter();
  if (!transport) return 'skipped';

  const recipients = (Array.isArray(input.to) ? input.to : [input.to])
    .map((address) => address.trim())
    .filter(Boolean);

  // Guards against an unconfigured recipient list silently producing a message with
  // nowhere to go. The submission itself is already stored, so this only costs the
  // notification.
  if (recipients.length === 0) {
    logger.error('Email not sent: no recipient configured', {
      subject: input.subject,
      hint: 'Set ADMIN_EMAILS in the backend .env file.',
    });
    return 'failed';
  }

  const type = input.type ?? 'unspecified';

  try {
    const info = await transport.sendMail({
      from: {
        name: sanitiseHeaderValue(config.smtp.fromName),
        address: config.smtp.fromEmail,
      },
      to: recipients,
      subject: sanitiseHeaderValue(input.subject),
      html: input.html,
      text: input.text,
      ...(input.replyTo ? { replyTo: sanitiseHeaderValue(input.replyTo) } : {}),
      ...(input.attachments?.length
        ? {
            attachments: input.attachments.map((attachment) => ({
              filename: sanitiseHeaderValue(attachment.filename),
              path: attachment.path,
              ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
            })),
          }
        : {}),
    });

    // A message id alone proves nothing — nodemailer returns one even when the server
    // refused every recipient. The accepted/rejected lists are the actual outcome.
    const accepted = (info.accepted ?? []).map(String);
    const rejected = (info.rejected ?? []).map(String);

    const detail = {
      type,
      subject: input.subject,
      recipients: recipients.length,
      accepted: accepted.length,
      rejected: rejected.length,
      rejectedAddresses: rejected.map(maskEmail),
      messageId: info.messageId,
      response: info.response,
      attachments: input.attachments?.length ?? 0,
    };

    if (accepted.length === 0) {
      logger.error('Email failed — every recipient was rejected', detail);
      return 'failed';
    }

    if (rejected.length > 0) {
      logger.warn('Email partially delivered', detail);
      return 'partial';
    }

    logger.info('Email sent', { ...detail, to: recipients.map(maskEmail) });
    return 'sent';
  } catch (error) {
    logger.error('Email failed', {
      type,
      to: recipients.map(maskEmail),
      subject: input.subject,
      ...describeError(error),
    });
    return 'failed';
  }
}

export type AdminNotificationInput = Omit<MailInput, 'to'>;

/**
 * Delivers an administrative notification to every address in ADMIN_EMAILS.
 *
 * This is the only way the application sends mail to the business — enquiries and
 * career applications both go through it — so adding a recipient is an .env change
 * and never a code change.
 */
export async function sendAdminNotification(input: AdminNotificationInput): Promise<MailResult> {
  return sendMail({ ...input, to: config.mail.adminRecipients });
}
