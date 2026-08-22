'use client';

/**
 * Refuses a module page to somebody the permission matrix says has no access.
 *
 * The sidebar hides the row and the API answers 403 — but the PAGE still
 * mounted, so a user holding nothing landed on the full Dashboards shell and was
 * invited to "create your first dashboard", over a console full of 403s. Hiding
 * a door is not locking it: URLs get typed, bookmarked and pasted into chat.
 *
 * Placed in the app shell rather than in each page, for the same reason the
 * backend gate moved to the router: a guard that every new page must remember to
 * add is a guard that will eventually be forgotten.
 *
 * NOT A SECURITY BOUNDARY. The server is. This turns a refusal that already
 * happens into one the reader can understand.
 */
import { useMemo } from 'react';
import { usePathname } from 'next/navigation';
import { ShieldOff } from 'lucide-react';

import { usePermissions, hasPermission } from '@/hooks/use-permissions';
import { moduleForPath } from '@/lib/moduleRoutes';
import { useI18n } from '@/providers/LanguageProvider';

export function ModuleAccessGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '';
  const { data, isLoading, isError } = usePermissions();
  const module = useMemo(() => moduleForPath(pathname), [pathname]);

  // Never block on an unanswered question. While permissions load — or if the
  // call fails — the page renders and the API stays the boundary; a guard that
  // flashes "no access" during every navigation would be worse than none.
  //
  // The cost, paid deliberately: on a COLD load a page without permission fires
  // its data hooks once and collects a few 403s in the console before the guard
  // resolves. Holding every page back until `/permissions/me` answers would move
  // that wait onto the critical path of every user who does have access, to tidy
  // the console for the rare one who does not. The requests are refused, which is
  // the system working.
  if (!module || isLoading || isError || !data) return <>{children}</>;
  if (hasPermission(data.permissions, module, 'view')) return <>{children}</>;

  return <NoModuleAccess module={module} />;
}

function NoModuleAccess({ module }: { module: string }) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-[70vh] items-center justify-center p-6">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-surface-2">
          <ShieldOff className="h-6 w-6 text-text-tertiary" aria-hidden="true" />
        </div>
        <h1 className="text-title font-emphasis text-text-primary">
          {t('permissions.noModuleAccess.title')}
        </h1>
        <p className="mt-2 text-body text-text-secondary">
          {t('permissions.noModuleAccess.body', { module: t(`settings.module.${module}`) })}
        </p>
      </div>
    </div>
  );
}
