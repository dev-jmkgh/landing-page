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

  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
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

/** Verifies SMTP credentials at startup. Logs the outcome; never throws. */
export async function verifyMailer(): Promise<boolean> {
  const transport = getTransporter();

  if (!transport) {
    logger.warn(
      'SMTP is not configured (SMTP_USER / SMTP_PASSWORD are empty). ' +
        'Enquiries will be stored but no email will be sent.',
    );
    return false;
  }

  try {
    await transport.verify();
    logger.info('SMTP connection verified', { host: config.smtp.host, user: maskEmail(config.smtp.user) });
    return true;
  } catch (error) {
    // Log the failure category, never the credentials.
    logger.error('SMTP verification failed', describeError(error));
    return false;
  }
}

function maskEmail(email: string): string {
  const [name = '', domain = ''] = email.split('@');
  if (!domain) return '***';
  return `${name.slice(0, 2)}***@${domain}`;
}

export type MailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
};

export type MailResult = 'sent' | 'skipped' | 'failed';

/**
 * Sends a message. Returns the outcome rather than throwing, so callers can record
 * whether a notification succeeded without failing the user's submission.
 */
export async function sendMail(input: MailInput): Promise<MailResult> {
  const transport = getTransporter();
  if (!transport) return 'skipped';

  try {
    await transport.sendMail({
      from: {
        name: sanitiseHeaderValue(config.smtp.fromName),
        address: config.smtp.fromEmail,
      },
      to: input.to,
      subject: sanitiseHeaderValue(input.subject),
      html: input.html,
      text: input.text,
      ...(input.replyTo ? { replyTo: sanitiseHeaderValue(input.replyTo) } : {}),
    });

    logger.info('Email sent', { to: maskEmail(input.to), subject: input.subject });
    return 'sent';
  } catch (error) {
    logger.error('Email delivery failed', {
      to: maskEmail(input.to),
      subject: input.subject,
      ...describeError(error),
    });
    return 'failed';
  }
}
