import '@xyflow/react/dist/style.css';
import './globals.css';
import type { Metadata, Viewport } from 'next';
import { Be_Vietnam_Pro, DM_Sans, Inter, JetBrains_Mono, Plus_Jakarta_Sans, Roboto, Source_Serif_4, Space_Grotesk } from 'next/font/google';
import { AppProviders } from './providers';

// PWA / iOS home-screen support. iOS Safari ignores the web manifest's install
// prompt entirely (no beforeinstallprompt) and needs these Apple-specific tags
// to (a) use our icon as the home-screen icon and (b) launch full-screen
// (standalone) when opened from the home screen.
export const metadata: Metadata = {
  applicationName: 'AppBI',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'AppBI',
  },
  icons: {
    apple: [{ url: '/icon-192.png' }],
  },
};

export const viewport: Viewport = {
  themeColor: '#0D3B7A',
};

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

const dmSans = DM_Sans({
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
  variable: '--font-dm-sans',
  preload: false,
});

// Report faces. Declared here so a dashboard theme can name one without the
// page fetching a stylesheet at render time. `preload: false` keeps them off
// the critical path — only a report that selects one pays for it.
// Be Vietnam Pro carries full Vietnamese diacritics, which most display faces
// drop to fallback glyphs at exactly the sizes a dashboard title uses.
const beVietnamPro = Be_Vietnam_Pro({
  subsets: ['latin', 'vietnamese'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-be-vietnam',
  preload: false,
});

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jakarta',
  preload: false,
});

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-grotesk',
  preload: false,
});

const sourceSerif = Source_Serif_4({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-serif',
  preload: false,
});

const roboto = Roboto({
  subsets: ['latin', 'latin-ext'],
  weight: ['400', '500', '700'],
  display: 'swap',
  variable: '--font-roboto',
  preload: false,
});

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable} ${dmSans.variable} ${roboto.variable} ${beVietnamPro.variable} ${plusJakarta.variable} ${spaceGrotesk.variable} ${sourceSerif.variable} h-full`}>
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
