import type { Metadata } from 'next';
import { TelecallingApp } from '@/components/admin/telecalling/TelecallingApp';

export const metadata: Metadata = {
  title: 'Telecalling',
  // Restricted area. A leaked admin URL must never reach a search index.
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Telecalling admin (spec: Admin Modules 1–15).
 *
 * Ships no data. Everything is fetched at runtime from the API with an authenticated
 * session cookie, so an unauthenticated visitor sees only the sign-in form — which is
 * also the only thing that could be exported into this page's static HTML.
 */
export default function AdminTelecallingPage() {
  return <TelecallingApp />;
}
