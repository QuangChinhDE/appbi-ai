import type { MetadataRoute } from 'next';

/**
 * PWA manifest for the public mini-app runtime.
 *
 * Model C (internal/PWA-first): users "Add to Home Screen" from the launcher
 * (`/m`) — no app store needed. start_url is the multi-workspace launcher.
 * Served by Next at /manifest.webmanifest and auto-linked into <head>.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'AppBI — Mini-App',
    short_name: 'AppBI',
    description: 'Ứng dụng nhập liệu & báo cáo (mini-app)',
    start_url: '/m',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0D3B7A',
    theme_color: '#0D3B7A',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
