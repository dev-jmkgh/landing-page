import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../../../config/env';
import { asyncHandler } from '../../../middleware/errorHandler';
import { notFound } from '../../../utils/httpError';
import { describeError, logger } from '../../../utils/logger';

/**
 * Short-lived download links for the HR app: payslip PDFs and shared documents.
 *
 * WHY A LINK AND NOT A BEARER REQUEST
 *
 * The app hands a download to the phone's browser or PDF viewer, which saves and opens
 * it the way the employee expects — and that viewer cannot send our Authorization
 * header. So the authenticated app asks for a link (the owning module checks the
 * employee may have the file), receives a token good for one file for a few minutes,
 * and opens `/api/hr/files/<token>`.
 *
 * The token is a JWT with its OWN audience, `jmk-hr-file`. All token families share a
 * signing secret, so the audience is what stops an access token being replayed here as
 * a file token, or a file token being used as a session.
 *
 * The resolver re-checks ownership when the link is followed, so a token minted for a
 * payslip that was since withdrawn, or a document since removed, finds nothing.
 */

const FILE_AUDIENCE = 'jmk-hr-file';
const ISSUER = 'jmk-api';

/** Five minutes: long enough to tap and wait on a slow network, short enough that a leaked URL is worth little. */
export const FILE_LINK_TTL_SECONDS = 300;

export type HrFileKind = 'payslip' | 'document';

type FilePayload = {
  /** The hr_users id the link was minted for. */
  sub: string;
  kind: HrFileKind;
  id: number;
};

/**
 * Mints a link. Call ONLY after checking the employee may read the file.
 *
 * Returns a PATH relative to the API root (`/hr/files/<token>`); the app prefixes its
 * own configured base URL, so the backend never has to know its public hostname.
 */
export function createHrFileLink(input: {
  userId: number;
  kind: HrFileKind;
  id: number;
}): { path: string; expiresAt: string } {
  const token = jwt.sign(
    { sub: String(input.userId), kind: input.kind, id: input.id },
    config.admin.jwtSecret,
    { expiresIn: FILE_LINK_TTL_SECONDS, issuer: ISSUER, audience: FILE_AUDIENCE },
  );
  return {
    path: `/hr/files/${token}`,
    expiresAt: new Date(Date.now() + FILE_LINK_TTL_SECONDS * 1000).toISOString(),
  };
}

function verifyFileToken(token: string): { userId: number; kind: HrFileKind; id: number } | null {
  try {
    const payload = jwt.verify(token, config.admin.jwtSecret, {
      issuer: ISSUER,
      audience: FILE_AUDIENCE,
    }) as Partial<FilePayload> | string;
    if (typeof payload === 'string') return null;
    const userId = Number(payload.sub);
    const id = Number(payload.id);
    if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(id) || id <= 0) return null;
    if (payload.kind !== 'payslip' && payload.kind !== 'document') return null;
    return { userId, kind: payload.kind, id };
  } catch {
    return null;
  }
}

/**
 * What a module hands back for a file. Either the bytes, or a URL to redirect to (a
 * presigned S3 URL, which keeps large files off this server).
 */
export type HrFileContent =
  | { kind: 'buffer'; body: Buffer; filename: string; mimeType: string }
  | { kind: 'redirect'; url: string };

/** `attachment` with an ASCII fallback and the RFC 5987 UTF-8 form for real names. */
export function contentDisposition(filename: string, disposition: 'attachment' | 'inline' = 'attachment'): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Mounted at `/api/hr/files`. Deliberately NOT behind `requireHrActor` — the token is
 * the credential — and deliberately answering every failure with the same 404, so the
 * endpoint says nothing about which tokens or files exist.
 *
 * The resolvers live with the modules that own the files and are loaded lazily, so this
 * router has no static dependency on payroll or documents:
 *   payslip  → payroll/payslipPdf.ts       `renderPayslipForEmployee(payslipId, userId)`
 *   document → requests/documents.service.ts `openDocumentForEmployee(documentId, userId)`
 * Each returns null when the employee may not have the file.
 */
export const hrFilesRouter = Router();

hrFilesRouter.get(
  '/:token',
  asyncHandler(async (request, response) => {
    const claims = verifyFileToken(String(request.params.token ?? ''));
    if (!claims) throw notFound('This link has expired. Go back and open the file again.');

    let content: HrFileContent | null = null;
    try {
      if (claims.kind === 'payslip') {
        const { renderPayslipForEmployee } = await import('../payroll/payslipPdf');
        content = await renderPayslipForEmployee(claims.id, claims.userId);
      } else {
        const { openDocumentForEmployee } = await import('../requests/documents.service');
        content = await openDocumentForEmployee(claims.id, claims.userId);
      }
    } catch (error) {
      logger.error('HR file link could not be served', { kind: claims.kind, ...describeError(error) });
      throw error;
    }

    if (!content) throw notFound('This file is no longer available.');

    response.setHeader('Cache-Control', 'private, no-store');

    if (content.kind === 'redirect') {
      response.redirect(302, content.url);
      return;
    }

    response.setHeader('Content-Type', content.mimeType);
    response.setHeader('Content-Length', String(content.body.length));
    response.setHeader('Content-Disposition', contentDisposition(content.filename));
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.end(content.body);
  }),
);
