import type { ReactNode } from 'react';

// Embed pages have no AppBI navigation chrome — just the bare content.
export default function EmbedLayout({ children }: { children: ReactNode }) {
  return children as any;
}
