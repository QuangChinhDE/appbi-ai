'use client';

/**
 * The palette — what an author can add, and what it will cost them.
 *
 * Grouped by family rather than alphabetically, because the question in an
 * author's head is "I need something that reads data" long before they know the
 * step is called a Tool. Every item is draggable AND clickable: dragging is
 * precise, clicking is faster, and forcing one over the other only annoys.
 */
import React, { useMemo, useState } from 'react';
import { Lock, Search } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Tabs } from '@/components/ui/Tabs';
import { useI18n } from '@/providers/LanguageProvider';
import type { AgentVersion, Palette } from '@/lib/aiFlows';
import { LOCKED_TYPES, themeFor } from '../canvas/nodeTheme';

const FAMILY_ORDER: { key: string; labelVi: string; labelEn: string }[] = [
  { key: 'system', labelVi: 'Hệ thống', labelEn: 'System' },
  { key: 'agent', labelVi: 'Chuyên gia AI', labelEn: 'AI specialists' },
  { key: 'data', labelVi: 'Đọc dữ liệu & tri thức', labelEn: 'Data & knowledge' },
  { key: 'check', labelVi: 'Kiểm tra', labelEn: 'Checks' },
  { key: 'control', labelVi: 'Điều hướng', labelEn: 'Control flow' },
];

interface Props {
  palette: Palette | null;
  agents: AgentVersion[];
  readOnly?: boolean;
  onAdd: (type: string) => void;
}

export function NodePalette({ palette, agents, readOnly, onAdd }: Props) {
  const { t, language } = useI18n();
  const [tab, setTab] = useState<'nodes' | 'tools'>('nodes');
  const [q, setQ] = useState('');

  const grouped = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const items = (palette?.node_types ?? []).filter((n) => {
      // Guard and End already exist in every graph; offering them is a dead click.
      if (LOCKED_TYPES.has(n.type)) return false;
      if (!needle) return true;
      return `${n.label_vi} ${n.type} ${n.description_vi}`.toLowerCase().includes(needle);
    });
    return FAMILY_ORDER.map((f) => ({
      ...f,
      items: items.filter((n) => themeFor(n.type).family === f.key),
    })).filter((f) => f.items.length > 0);
  }, [palette, q]);

  const tools = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (palette?.tools ?? []).filter(
      (x) => !needle || `${x.label_vi} ${x.name} ${x.description_vi}`.toLowerCase().includes(needle),
    );
  }, [palette, q]);

  const publishedAgents = agents.filter((a) => a.status === 'published');

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-[rgb(var(--border-line))] p-3">
        <div className="text-tiny font-strong uppercase tracking-wide text-text-quaternary">
          {t('aiFlows.palette.title')}
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-quaternary" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('aiFlows.common.search')}
            className="!pl-7"
          />
        </div>
        <Tabs
          size="sm"
          variant="pill"
          value={tab}
          onChange={setTab}
          items={[
            { key: 'nodes', label: t('aiFlows.palette.tabNodes') },
            { key: 'tools', label: t('aiFlows.palette.tabTools') },
          ]}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === 'nodes' ? (
          <div className="space-y-4">
            {grouped.map((family) => (
              <div key={family.key}>
                <div className="mb-1.5 text-[10px] font-strong uppercase tracking-wider text-text-quaternary">
                  {language === 'vi' ? family.labelVi : family.labelEn}
                </div>
                <div className="space-y-1.5">
                  {family.items.map((nt) => {
                    const theme = themeFor(nt.type);
                    const Icon = theme.icon;
                    const locked = LOCKED_TYPES.has(nt.type);
                    return (
                      <button
                        key={nt.type}
                        type="button"
                        disabled={readOnly}
                        draggable={!readOnly}
                        onDragStart={(e) => {
                          e.dataTransfer.setData('application/appbi-node', nt.type);
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        onClick={() => onAdd(nt.type)}
                        title={nt.description_vi}
                        className={`flex w-full cursor-grab items-start gap-2 rounded-lg border bg-white px-2.5 py-2 text-left transition-all
                          ${theme.border} hover:-translate-y-px hover:shadow-sm
                          disabled:cursor-not-allowed disabled:opacity-50`}
                      >
                        <span className={`mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded ${theme.iconBg} ${theme.iconFg}`}>
                          <Icon className="h-3 w-3" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1">
                            <span className="truncate text-caption font-emphasis text-text-primary">
                              {nt.label_vi}
                            </span>
                            {theme.usesLlm && (
                              <Badge variant="warning" size="xs">{t('aiFlows.palette.badgeAI')}</Badge>
                            )}
                            {locked && (
                              <Lock
                                className="h-3 w-3 flex-shrink-0 text-text-quaternary"
                                aria-label={t('aiFlows.palette.locked')}
                              />
                            )}
                          </span>
                          <span className="mt-0.5 block text-tiny leading-tight text-text-tertiary">
                            {nt.description_vi}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

            {publishedAgents.length > 0 && (
              <div>
                <div className="mb-1.5 text-[10px] font-strong uppercase tracking-wider text-text-quaternary">
                  {t('aiFlows.palette.tabAgents')}
                </div>
                <div className="space-y-1">
                  {publishedAgents.map((a) => (
                    <div
                      key={a.ref}
                      className="rounded-lg border border-[#CBB8F5] bg-[#F1ECFF]/50 px-2.5 py-1.5"
                    >
                      <div className="truncate text-tiny font-emphasis text-text-primary">
                        {a.display_name}
                      </div>
                      <div className="truncate text-[10px] text-text-tertiary">
                        {a.ref} · {a.model_policy}
                      </div>
                    </div>
                  ))}
                </div>
                <p className="mt-1.5 text-[10px] leading-tight text-text-quaternary">
                  {t('aiFlows.inspector.agentHint')}
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-1.5">
            {tools.map((tool) => (
              <div
                key={tool.name}
                className="rounded-lg border border-[#9EDCE1] bg-[#E8FAFA]/50 px-2.5 py-1.5"
              >
                <div className="flex items-center gap-1">
                  <span className="truncate text-tiny font-emphasis text-text-primary">
                    {tool.label_vi}
                  </span>
                  <CostBadge cls={tool.cost_class} />
                </div>
                <div className="mt-0.5 text-[10px] leading-tight text-text-tertiary">
                  {tool.description_vi}
                </div>
              </div>
            ))}
            <p className="pt-1 text-[10px] leading-tight text-text-quaternary">
              {t('aiFlows.inspector.tools')} — {t('aiFlows.palette.dragHint')}
            </p>
          </div>
        )}
      </div>

      <div className="border-t border-[rgb(var(--border-line))] p-3">
        <p className="text-[10px] leading-relaxed text-text-tertiary">
          {t('aiFlows.palette.hint')}
        </p>
      </div>
    </div>
  );
}

export function CostBadge({ cls }: { cls: string }) {
  if (cls === 'external') return <Badge variant="warning" size="xs">web</Badge>;
  if (cls === 'data_query') return <Badge variant="info" size="xs">truy vấn</Badge>;
  if (cls === 'expensive') return <Badge variant="danger" size="xs">nặng</Badge>;
  return <Badge variant="subtle" size="xs">rẻ</Badge>;
}
