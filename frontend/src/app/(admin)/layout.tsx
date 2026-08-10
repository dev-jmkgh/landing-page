import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

/** The admin area deliberately omits the marketing header, footer and enquiry widget. */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
