import type { Metadata } from 'next';
import { AdminApp } from '@/components/admin/AdminApp';

export const metadata: Metadata = {
  title: 'Enquiry management',
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Restricted area. The page ships no data — everything is fetched from the API with an
 * authenticated session cookie, so an unauthenticated visitor only ever sees the login
 * form.
 */
export default function AdminEnquiriesPage() {
  return <AdminApp />;
}
