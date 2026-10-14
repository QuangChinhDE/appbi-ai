'use client';

/**
 * Where a published flow actually ends up — the step after Publish.
 *
 * THE GAP THIS CLOSES. Publish writes a version. It does not make the assistant
 * reachable by anyone: a reader meets it only through a report's public link,
 * and that binding is configured on the dashboard, not here. The builder's only
 * acknowledgement of this was the text `· 1 link`, which was not a link, not a
 * button, and hidden below 2xl. An author who had just published had no way to
 * learn that they were one step short of a working product, or where that step
 * lives.
 *
 * NO SECOND BINDING SYSTEM. The dashboard's public link owns the binding and
 * stays the source of truth. This reads `brainImpact()` — which the builder
 * already fetched — and routes the author to the place that owns the decision.
 * It creates nothing and mutates nothing, so it cannot drift from the real state
 * and cannot be used to bypass the permission checks that live on that path.
 *
 * TRUTHFUL STATES ONLY. Each line below is derived from data the backend already
 * returns. `attached but paused` exists because `link_active` and `bot_enabled`
 * are separate facts from `status`, and a flow bound to a switched-off link is
 * neither live nor unattached — telling an author it is "live" would be the kind
 * of confident wrong answer the rest of this product works to avoid.
 */
import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, CheckCircle2, Circle } from 'lucide-react';

import { useI18n } from '@/providers/LanguageProvider';
import { type FlowLinkUsage } from '@/lib/agentFlows';

export function FlowActivation({
  links,
  publishedVersion,
  draftVersion,
}: {
  links: FlowLinkUsage[];
  publishedVersion: number | null;
  draftVersion: number;
}) {
  const { t } = useI18n();

  // A link only serves readers when it is active AND its assistant is on. Those
  // are two switches on the dashboard, and either one off means nobody arrives.
  const serving = links.filter((l) => l.link_active && l.bot_enabled);
  const attached = links.length;
  const paused = attached - serving.length;

  if (publishedVersion == null) {
    return (
      <Strip tone="idle" icon={<Circle className="h-3.5 w-3.5" />}>
        <span>{t('agentFlows.activation.draftOnly')}</span>
      </Strip>
    );
  }

  if (attached === 0) {
    return (
      <Strip tone="attention" icon={<AlertTriangle className="h-3.5 w-3.5" />}>
        <span className="font-medium">{t('agentFlows.activation.publishedTitle')}</span>
        <span className="text-text-secondary">{t('agentFlows.activation.unbound')}</span>
        <Link
          href="/dashboards"
          className="ml-auto inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1 font-medium transition-colors hover:bg-surface-2"
        >
          {t('agentFlows.activation.attachCta')} <ArrowRight className="h-3 w-3" />
        </Link>
      </Strip>
    );
  }

  const first = serving[0] ?? links[0];
  const stale = publishedVersion !== draftVersion;

  return (
    <Strip tone="live" icon={<CheckCircle2 className="h-3.5 w-3.5" />}>
      <span className="font-medium">
        {t(serving.length === 1 ? 'agentFlows.activation.bound' : 'agentFlows.activation.boundPlural',
          { count: serving.length || attached })}
      </span>
      {/* The report's own name, never a link id or a binding id. */}
      <span className="min-w-0 truncate text-text-secondary">{first?.link_name}</span>
      {paused > 0 && (
        <span className="flex-shrink-0 text-warning">· {t('agentFlows.activation.paused')}</span>
      )}
      {stale && (
        <span className="flex-shrink-0 text-warning">
          · {t('agentFlows.activation.staleDraft', { version: publishedVersion })}
        </span>
      )}
      {first?.dashboard_id != null && (
        <Link
          href={`/dashboards/${first.dashboard_id}`}
          className="ml-auto inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1 font-medium transition-colors hover:bg-surface-2"
        >
          {attached > 1 ? t('agentFlows.activation.manage') : t('agentFlows.activation.openReport')}
          <ArrowRight className="h-3 w-3" />
        </Link>
      )}
    </Strip>
  );
}

function Strip({
  tone,
  icon,
  children,
}: {
  tone: 'idle' | 'attention' | 'live';
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const skin =
    tone === 'live'
      ? 'border-success/30 bg-success/5 text-success'
      : tone === 'attention'
        ? 'border-warning/35 bg-warning/5 text-warning'
        : 'border-[rgb(var(--border-line))] bg-surface-2 text-text-tertiary';
  return (
    <div
      data-testid="flow-activation"
      data-tone={tone}
      className={`flex min-w-0 items-center gap-2 border-b px-3 py-1.5 text-caption ${skin}`}
    >
      <span className="flex-shrink-0">{icon}</span>
      {children}
    </div>
  );
}
