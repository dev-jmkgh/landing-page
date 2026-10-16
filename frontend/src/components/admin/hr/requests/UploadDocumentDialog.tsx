'use client';

import { HrDialog } from '../leave/shared';
import { ShareDocumentForm, type ShareResult } from './ShareDocumentForm';

/**
 * The Documents screen's upload: the share form in a dialog, choosing the audience —
 * one employee, or everyone. Mounted only while open, so each opening starts empty.
 */
export function UploadDocumentDialog({
  onClose,
  onShared,
  onUnauthorized,
}: {
  onClose: () => void;
  onShared: (result: ShareResult) => void;
  onUnauthorized: () => void;
}) {
  return (
    <HrDialog
      title="Share a document"
      eyebrow="Documents"
      sub="A PDF, PNG or JPEG, for one employee or for everyone."
      onClose={onClose}
    >
      <ShareDocumentForm layout="dialog" onShared={onShared} onCancel={onClose} onUnauthorized={onUnauthorized} />
    </HrDialog>
  );
}
