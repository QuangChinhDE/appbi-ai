import './globals.css';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { AppProviders } from './providers';

const inter = Inter({
  subsets: ['latin', 'vietnamese'],
  display: 'swap',
  variable: '--font-inter',
  axes: ['opsz'],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
});

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="antialiased font-sans">
        <AppProviders>
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
