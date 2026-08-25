import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config/env';
import { describeError, logger } from '../utils/logger';
import { sanitiseHeaderValue } from '../utils/text';

/**
 * The mail transport — Amazon SES or SMTP, chosen by MAIL_PROVIDER.
 *
 * Both are built as nodemailer transports on purpose. Everything above this line —
 * templates, attachments, reply-to, the accepted/rejected reporting, the retry-free
 * "store first, notify after" contract — is written against nodemailer's interface, so
 * switching provider changes the transport and nothing else.
 *
 * Credentials never appear here. SMTP takes a username and an App Password from the
 * environment; SES takes nothing, because the AWS SDK resolves credentials through its
 * own provider chain (environment, shared config, then the EC2 instance role). That is
 * what lets the same build run on an instance profile with no key anywhere on disk.
 *
 * If the transport is not configured, email is disabled and the API continues to
 * validate and store submissions — a failed notification never fails a user's request.
 */

let transporter: Transporter | null = null;

function createSesTransport(): Transporter {
  // No `credentials` argument: omitting it is what engages the default provider chain.
  const sesClient = new SESv2Client({ region: config.smtp.region });

  // Nodemailer 9 wants the v2 client and `SendEmailCommand` under `sesClient` /
  // `SendEmailCommand`. The older `{ ses, aws: { SendRawEmailCommand } }` shape from
  // @aws-sdk/client-ses is rejected outright at createTransport with ECONFIG — it is
  // still what most examples show, and it fails at startup rather than at send time.
  const options = {
    SES: { sesClient, SendEmailCommand },
    // SES accounts have a per-second send quota; this keeps a burst of submissions
    // from tripping it.
    sendingRate: 10,
  };

  // @types/nodemailer is still on 6.x and has no SES member on TransportOptions, so
  // the object is cast rather than the types being fought. Nodemailer itself validates
  // this shape at createTransport and throws ECONFIG if it is wrong, which is a
  // stricter check than the type would have been.
  return nodemailer.createTransport(options as unknown as Parameters<typeof nodemailer.createTransport>[0]);
}

function getTransporter(): Transporter | null {
  if (!config.smtp.enabled) return null;
  if (transporter) return transporter;

  if (config.smtp.provider === 'ses') {
    transporter = createSesTransport();
    return transporter;
  }

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
  const common = {
    provider: config.smtp.provider,
    from: config.smtp.fromEmail ? maskEmail(config.smtp.fromEmail) : '(empty)',
    enabled: config.smtp.enabled,
    adminRecipientCount: config.mail.adminRecipients.length,
    adminRecipients: config.mail.adminRecipients.map(maskEmail),
  };

  if (config.smtp.provider === 'ses') {
    // Region only. Nothing about the credentials — not whether they came from the
    // environment or an instance role, not whether they are present, and certainly not
    // their value. This report is reachable from a diagnostics endpoint.
    return { ...common, region: config.smtp.region };
  }

  return {
    ...common,
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    user: config.smtp.user ? maskEmail(config.smtp.user) : '(empty)',
    passwordConfigured: config.smtp.password.length > 0,
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

  // A From value with no local part is not an address, and SES rejects the send with
  // an error naming the parameter rather than the mistake. Caught at startup instead.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.smtp.fromEmail)) {
    logger.error(
      'SMTP_FROM_EMAIL is not a valid email address. A host name is not an address — ' +
        'it needs a local part, e.g. no-reply@example.com.',
      { from: config.smtp.fromEmail },
    );
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

  const label = config.smtp.provider === 'ses' ? 'SES' : 'SMTP';

  try {
    await transport.verify();
    // The full effective config goes in the success line too, so a working startup
    // still shows which account and how many recipients are actually in play.
    logger.info(`${label} transport verified`, mailConfigReport());
    return true;
  } catch (error) {
    // Log the failure category and the configuration, never the credentials.
    logger.error(`${label} verification failed`, {
      ...mailConfigReport(),
      ...describeSendFailure(error),
      hint:
        config.smtp.provider === 'ses'
          ? 'Check that SMTP_FROM_EMAIL is a verified identity in AWS_REGION, that the ' +
            'account has left the SES sandbox, and that the resolved AWS identity has ' +
            'ses:SendRawEmail.'
          : 'For Gmail, SMTP_PASSWORD must be a 16-character App Password (Google Account > ' +
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
  /**
   * The bytes. Used when the request already held the file, and when it came from a
   * bucket rather than a path — SES sends a raw MIME message, so an attachment has to
   * be materialised either way.
   */
  content?: Buffer;
  /** File on disk. Streamed by nodemailer; never read into memory here. */
  path?: string;
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

/**
 * Pulls the parts of a send failure that actually identify the cause.
 *
 * `describeError` gives name and message, which is enough for SMTP. AWS SDK errors
 * carry more and it is the part that matters: the HTTP status separates "your
 * credentials are wrong" from "this address is not verified", and the request id is
 * what AWS support asks for first. None of these fields ever contains a credential.
 *
 * The common SES failures are worth naming outright, because the raw messages are
 * indirect and cost an hour each the first time you meet them.
 */
function describeSendFailure(error: unknown): Record<string, unknown> {
  const base = describeError(error);
  const aws = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number; requestId?: string; attempts?: number };
    Code?: string;
  };

  const detail: Record<string, unknown> = { ...base };
  if (aws?.$metadata) {
    detail.httpStatusCode = aws.$metadata.httpStatusCode;
    detail.awsRequestId = aws.$metadata.requestId;
    detail.attempts = aws.$metadata.attempts;
  }
  if (aws?.Code) detail.awsCode = aws.Code;

  const name = aws?.name ?? '';
  const message = base.message as string | undefined;

  if (name === 'MessageRejected' && /not verified/i.test(message ?? '')) {
    detail.likelyCause =
      'The From address is not a verified identity in this SES region, or the account ' +
      'is still in the SES sandbox and the recipient is not verified either. Verify ' +
      'the identity in SES, or request production access.';
  } else if (name === 'CredentialsProviderError' || name === 'UnrecognizedClientException') {
    detail.likelyCause =
      'SES could not resolve AWS credentials. On EC2 attach an instance role; ' +
      'locally set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or configure a profile.';
  } else if (name === 'AccessDenied' || name === 'AccessDeniedException') {
    detail.likelyCause = 'The resolved AWS identity lacks ses:SendRawEmail in this region.';
  }

  return detail;
}

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
              ...(attachment.content ? { content: attachment.content } : {}),
              ...(attachment.path ? { path: attachment.path } : {}),
              ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
            })),
          }
        : {}),
    });

    // A message id alone proves nothing over SMTP — nodemailer returns one even when
    // the server refused every recipient, so the accepted/rejected lists are the real
    // outcome there.
    //
    // SES reports neither list. Its transport resolves with a message id on success and
    // throws on failure, so on SES an empty pair means "accepted", not "refused". Left
    // unhandled this read as a total rejection and every SES send would have been
    // logged as failed and reported to the user as an email that did not go out.
    const reportedAccepted = (info.accepted ?? []).map(String);
    const rejected = (info.rejected ?? []).map(String);
    const accepted =
      reportedAccepted.length === 0 && rejected.length === 0 && info.messageId
        ? recipients
        : reportedAccepted;

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
      provider: config.smtp.provider,
      from: maskEmail(config.smtp.fromEmail),
      to: recipients.map(maskEmail),
      subject: input.subject,
      ...describeSendFailure(error),
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
