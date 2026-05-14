/**
 * Screen icon registry — single source of truth shared between the
 * builder (icon picker) and the runtime (`/ws/[token]/workboards/[wbid]`
 * `pickIcon`). The runtime can't render arbitrary Lucide icon names
 * because tree-shaking would strip them, and asking users to type
 * "ClipboardEdit" by hand is hostile. So we keep a finite whitelist
 * here, expose it as a picker in the builder, and import the SAME
 * mapping in the runtime to avoid drift.
 *
 * Adding a new icon: import it from `lucide-react`, add an entry to
 * ``SCREEN_ICONS`` with a stable ``id`` (Pascal-case Lucide name) and
 * a short human label. The runtime mapping is derived automatically.
 */
import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle,
  BarChart3,
  Bell,
  Calendar,
  CheckCircle2,
  ClipboardEdit,
  ClipboardList,
  Eye,
  Factory,
  FileText,
  Folder,
  Grid3x3,
  Home,
  ImageIcon,
  LayoutDashboard,
  ListChecks,
  Mail,
  MapPin,
  MoreHorizontal,
  Phone,
  PieChart,
  PlusCircle,
  Search,
  Settings,
  Star,
  Table2,
  Truck,
  Users,
} from 'lucide-react';

export interface ScreenIconEntry {
  /** Stable id stored in the workboard spec (e.g. ``ClipboardEdit``). */
  id: string;
  /** Short human label for the picker (e.g. ``"Form"``). */
  label: string;
  /** The Lucide component to render. */
  component: LucideIcon;
  /** Loose categorisation so the picker groups visually. */
  group: 'common' | 'business' | 'communication' | 'misc';
}

// Order within each group is the order shown in the picker. Curated
// roughly by how often each shows up in real mini-apps — common kinds
// first so the user lands the right pick with the minimum scroll.
export const SCREEN_ICONS: ScreenIconEntry[] = [
  // Common screen kinds
  { id: 'ClipboardEdit', label: 'Form', component: ClipboardEdit, group: 'common' },
  { id: 'ClipboardList', label: 'Checklist', component: ClipboardList, group: 'common' },
  { id: 'ListChecks', label: 'List', component: ListChecks, group: 'common' },
  { id: 'Grid3x3', label: 'Grid', component: Grid3x3, group: 'common' },
  { id: 'LayoutDashboard', label: 'Dashboard', component: LayoutDashboard, group: 'common' },
  { id: 'FileText', label: 'Document', component: FileText, group: 'common' },
  { id: 'Table2', label: 'Table', component: Table2, group: 'common' },
  { id: 'PieChart', label: 'Chart', component: PieChart, group: 'common' },
  { id: 'BarChart3', label: 'Bar chart', component: BarChart3, group: 'common' },
  { id: 'Home', label: 'Home', component: Home, group: 'common' },

  // Business / operations
  { id: 'Factory', label: 'Factory', component: Factory, group: 'business' },
  { id: 'Truck', label: 'Truck', component: Truck, group: 'business' },
  { id: 'Users', label: 'Users', component: Users, group: 'business' },
  { id: 'Folder', label: 'Folder', component: Folder, group: 'business' },
  { id: 'Star', label: 'Star', component: Star, group: 'business' },
  { id: 'Settings', label: 'Settings', component: Settings, group: 'business' },

  // Communication / alerts
  { id: 'Bell', label: 'Bell', component: Bell, group: 'communication' },
  { id: 'Mail', label: 'Mail', component: Mail, group: 'communication' },
  { id: 'Phone', label: 'Phone', component: Phone, group: 'communication' },
  { id: 'AlertTriangle', label: 'Alert', component: AlertTriangle, group: 'communication' },
  { id: 'CheckCircle2', label: 'Check', component: CheckCircle2, group: 'communication' },
  { id: 'PlusCircle', label: 'Plus', component: PlusCircle, group: 'communication' },

  // Misc
  { id: 'Calendar', label: 'Calendar', component: Calendar, group: 'misc' },
  { id: 'MapPin', label: 'Map', component: MapPin, group: 'misc' },
  { id: 'Search', label: 'Search', component: Search, group: 'misc' },
  { id: 'Eye', label: 'Eye', component: Eye, group: 'misc' },
  { id: 'ImageIcon', label: 'Image', component: ImageIcon, group: 'misc' },
  { id: 'MoreHorizontal', label: 'More', component: MoreHorizontal, group: 'misc' },
];

export const GROUP_LABELS: Record<ScreenIconEntry['group'], string> = {
  common: 'Common',
  business: 'Business',
  communication: 'Communication',
  misc: 'Other',
};

/** id → component map. Used by the runtime to resolve a stored name. */
export const SCREEN_ICON_MAP: Record<string, LucideIcon> = SCREEN_ICONS.reduce(
  (acc, entry) => {
    acc[entry.id] = entry.component;
    return acc;
  },
  {} as Record<string, LucideIcon>,
);

/** Backwards-compat aliases the runtime accepted historically. Keep them
 * so existing layouts that wrote ``Image`` or ``Map`` keep rendering. */
SCREEN_ICON_MAP.Image = ImageIcon;
SCREEN_ICON_MAP.Map = MapPin;
SCREEN_ICON_MAP.Table = Table2;

export function resolveScreenIcon(name?: string | null): LucideIcon | null {
  if (!name) return null;
  return SCREEN_ICON_MAP[name] ?? null;
}
