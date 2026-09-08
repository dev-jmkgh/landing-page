import type { Metadata } from 'next';
import { AdminLoginScreen } from '@/components/admin/AdminLoginScreen';

export const metadata: Metadata = {
  title: 'Admin sign in',
  // Restricted area. A leaked admin URL must never reach a search index.
  robots: { index: false, follow: false, nocache: true },
};

/**
 * The one address for administrator sign-in: `/admin/login/`.
 *
 * Previously the form was rendered in place by whichever admin screen you happened to
 * open, so there was no URL to bookmark or to hand to a new member of staff, and the
 * address bar said `/admin/enquiries/` while the screen said "sign in".
 *
 * Ships no data. An unauthenticated visitor can only ever see this form, which is also
 * the only thing present in this page's exported HTML.
 */
export default function AdminLoginPage() {
  return <AdminLoginScreen />;
}
