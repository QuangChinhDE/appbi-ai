import type { ModuleCatalog } from '../messages';

// Public-surface strings (/d/[token] public link, /embed/[token], /ws/[token]
// workspace portal + workboard runtime). Rendered via the local-only useI18n,
// so no authenticated calls — keep these self-contained.
export const publicCatalog: ModuleCatalog = {
  en: {},
  vi: {},
};
