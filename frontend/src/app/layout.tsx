import './globals.css';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { AppProviders } from './providers';

const inter = Inter({
  subsets: ['latin', 'vietnamese'],
  display: 'swap',
  variable: '--font-inter',
  axes: ['opsz'],
  preload: false,
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
  preload: false,
});

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable} h-full`}>
      {/*
        Don't lock <body> overflow here — public/embed routes (/d/[token],
        /embed/[token]) rely on body scroll. The authenticated app's own
        layout already sets `h-screen overflow-hidden` on its outermost
        wrapper, so the 2-scroll problem stays fixed for that surface.
      */}
      <body className="antialiased font-sans h-full">
        <AppProviders>
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
