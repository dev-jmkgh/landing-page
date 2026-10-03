import type { Metadata } from 'next';
import { HrApp } from '@/components/admin/hr/HrApp';

export const metadata: Metadata = {
  title: 'HR',
  // Restricted area. A leaked admin URL must never reach a search index.
  robots: { index: false, follow: false, nocache: true },
};

/**
 * HR admin — the employee list and the self-registration approval queue.
 *
 * Ships no data. Everything is fetched at runtime from the API with an authenticated
 * session cookie, so an unauthenticated visitor sees only the sign-in form — which is
 * also the only thing that could be exported into this page's static HTML.
 */
export default function AdminHrPage() {
  return <HrApp />;
}
