import './globals.css';
import { Inter } from 'next/font/google';
import { AppProviders } from './providers';

const inter = Inter({
  subsets: ['latin'],
  preload: false,
  display: 'swap',
});

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <AppProviders>
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
