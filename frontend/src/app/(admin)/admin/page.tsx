import type { Metadata } from 'next';
import { AdminIndexRedirect } from '@/components/admin/AdminIndexRedirect';

export const metadata: Metadata = {
  title: 'Admin',
  robots: { index: false, follow: false, nocache: true },
};

/**
 * `/admin/` itself.
 *
 * There was no page here, so the most obvious URL anyone would type returned a 404 and
 * the real entry points had to be known in advance. This sends visitors to the
 * telecalling dashboard, or to sign in if they have no session.
 */
export default function AdminIndexPage() {
  return <AdminIndexRedirect />;
}
