import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Aquilo',
  description: 'Aquilo streaming tools for creators.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
