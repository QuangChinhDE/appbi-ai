'use client';

import { PublicDashboardView } from '@/components/dashboards/PublicDashboardView';

// Embed link (/embed/<token>) for iframing into a host app. Same report surface
// as the public /d page — the shared PublicDashboardView in "embed" variant
// grows to its content height and reports it to the parent frame (auto-resize),
// hides the AI bot, and otherwise renders every feature the public page has
// (non-chart widgets, slicer cluster, cross-highlight, locked-filter banner,
// PDF export, theming). Resolve a rotating embed token via the integrations API.
export default function EmbedDashboardPage() {
  return <PublicDashboardView variant="embed" />;
}
