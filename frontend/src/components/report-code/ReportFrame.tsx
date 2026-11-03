'use client';

/**
 * The host side of a Report-as-Code frame.
 *
 * Security contract (docs/features/report-as-code/RFC-v2.1.md §1):
 * - never forms, popups or top navigation; an ISOLATED document (served from the
 *   report origin, which must differ from the app origin) also gets allow-same-origin
 *   so its runtime can cancel navigations before they are sent; anything else is
 *   framed opaque, where report JavaScript does not run (frameSandbox);
 * - one MessagePort is handed over on the first load; nothing else is ever trusted;
 * - the frame gets data only as DTOs the backend minted for declared bindings;
 * - a second `load` (a navigation the guard did not stop) tears the frame down.
 *
 * This component never calls an API itself. The caller passes the fetchers, so the
 * studio uses the signed-in client and the public pages use the public client.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  PROTOCOL_VERSION,
  applyFilter,
  frameSandbox,
  parseSandboxMessage,
  type FilterState,
  type ReportBindingDecl,
  type ReportFilterDecl,
} from '@/lib/report-code/protocol';

export interface RuntimeIssue { kind: string; message: string; at: number }

export interface ReportFrameProps {
  src: string;
  /** Live preview of unsaved code: the source is POSTed into the frame (src is then the action URL). */
  post?: Record<string, string>;
  /** Served from the isolated report origin (navigation guard available). */
  isolated?: boolean;
  onGuard?: (state: { guard: boolean; authorScript?: 'ran' | 'refused' }) => void;
  bindings: ReportBindingDecl[];
  filters: ReportFilterDecl[];
  fetchData: (bindingId: string, state: FilterState) => Promise<unknown>;
  fetchValues: (key: string, search: string, state: FilterState) => Promise<unknown[]>;
  mode?: 'studio' | 'view';
  selectMode?: boolean;
  selectedRegion?: string | null;
  onRegionSelected?: (region: string) => void;
  onIssue?: (issue: RuntimeIssue) => void;
  onStateChange?: (state: FilterState) => void;
  className?: string;
  title?: string;
}

const PARALLEL = 4;

export function ReportFrame({
  src, post, isolated = false, onGuard, bindings, filters, fetchData, fetchValues, mode = 'view', selectMode = false, selectedRegion = null,
  onRegionSelected, onIssue, onStateChange, className, title,
}: ReportFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const portRef = useRef<MessagePort | null>(null);
  const loadsRef = useRef(0);
  const stateRef = useRef<FilterState>({});
  const seqRef = useRef<Record<string, number>>({});
  const propsRef = useRef({ bindings, filters, fetchData, fetchValues, onRegionSelected, onIssue, onStateChange, onGuard, mode });
  propsRef.current = { bindings, filters, fetchData, fetchValues, onRegionSelected, onIssue, onStateChange, onGuard, mode };
  const [blocked, setBlocked] = useState(false);
  const [frameName] = useState(() => Math.random().toString(36).slice(2));

  const postMsg = useCallback((msg: unknown) => { portRef.current?.postMessage(msg); }, []);

  const pushContext = useCallback(() => {
    const p = propsRef.current;
    postMsg({ type: 'context', filters: p.filters, state: stateRef.current, bindings: p.bindings, mode: p.mode, locale: 'vi-VN' });
  }, [postMsg]);

  const loadAll = useCallback(async () => {
    const { bindings: list, fetchData: fetcher } = propsRef.current;
    const state = stateRef.current;
    const queue = [...list];
    const worker = async () => {
      for (let b = queue.shift(); b; b = queue.shift()) {
        const id = b.id;
        const seq = (seqRef.current[id] = (seqRef.current[id] || 0) + 1);
        let dto: unknown;
        try {
          dto = await fetcher(id, state);
        } catch (e: any) {
          dto = { bindingId: id, status: 'error', error: e?.response?.data?.detail || 'Không tải được dữ liệu', rows: [], fields: [] };
        }
        if (seqRef.current[id] === seq) postMsg({ type: 'data', id, dto });
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
  }, [postMsg]);

  const onMessage = useCallback(async (event: MessageEvent) => {
    const p = propsRef.current;
    const msg = parseSandboxMessage(event.data, p.filters);
    if (!msg) return;
    switch (msg.type) {
      case 'ready':
        p.onGuard?.({ guard: msg.guard });
        pushContext();
        void loadAll();
        break;
      case 'setFilter':
        stateRef.current = applyFilter(stateRef.current, msg.key, msg.value);
        p.onStateChange?.(stateRef.current);
        pushContext();
        void loadAll();
        break;
      case 'clearFilters':
        stateRef.current = {};
        p.onStateChange?.(stateRef.current);
        pushContext();
        void loadAll();
        break;
      case 'values': {
        let values: unknown[] = [];
        try { values = await p.fetchValues(msg.key, msg.search, stateRef.current); } catch { values = []; }
        postMsg({ type: 'values', reqId: msg.reqId, values: values.slice(0, 200) });
        break;
      }
      case 'guard':
        p.onGuard?.({ guard: msg.guard, authorScript: msg.authorScript });
        break;
      case 'region':
        p.onRegionSelected?.(msg.region);
        break;
      case 'error':
        p.onIssue?.({ kind: msg.kind, message: msg.message, at: Date.now() });
        break;
    }
  }, [loadAll, postMsg, pushContext]);

  const appOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
  const sandbox = frameSandbox(src, isolated, appOrigin);
  let targetOrigin = '*';
  if (isolated) { try { targetOrigin = new URL(src, appOrigin).origin; } catch { targetOrigin = '*'; } }

  const handleLoad = useCallback(() => {
    const frame = frameRef.current;
    if (!frame) return;
    // In POST mode the frame first holds an empty about:blank; only the posted document counts.
    try { if (frame.contentWindow?.location.href === 'about:blank') return; } catch { /* cross-origin: the real document */ }
    loadsRef.current += 1;
    if (loadsRef.current > 1) {
      // The report left its document (self-navigation): close the channel and the frame.
      portRef.current?.close();
      portRef.current = null;
      setBlocked(true);
      propsRef.current.onIssue?.({ kind: 'security', message: 'Báo cáo cố điều hướng ra khỏi trang của nó và đã bị chặn.', at: Date.now() });
      return;
    }
    const channel = new MessageChannel();
    channel.port1.onmessage = onMessage;
    portRef.current = channel.port1;
    // The init carries no secret, only the port. An isolated document has a real
    // origin we can name; an opaque one ("null") can only be reached with '*'.
    frame.contentWindow?.postMessage({ type: 'rac:init', v: PROTOCOL_VERSION, context: {
      filters: propsRef.current.filters, state: stateRef.current, bindings: propsRef.current.bindings,
      mode: propsRef.current.mode, locale: 'vi-VN',
    } }, targetOrigin, [channel.port2]);
  }, [onMessage, targetOrigin]);

  useEffect(() => {
    loadsRef.current = 0;
    setBlocked(false);
    return () => { portRef.current?.close(); portRef.current = null; };
  }, [src]);

  const postKey = post ? JSON.stringify(post).length + ':' + (post.html || '').slice(0, 64) : '';
  useEffect(() => {
    const frame = frameRef.current;
    if (!post || !frame || !sandbox) return;
    // A host-initiated re-render: the next load is the new document, not a navigation.
    portRef.current?.close();
    portRef.current = null;
    loadsRef.current = 0;
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = src;
    form.target = frame.name;
    form.style.display = 'none';
    Object.entries(post).forEach(([k, v]) => {
      const input = document.createElement('textarea');
      input.name = k;
      input.value = v;
      form.appendChild(input);
    });
    document.body.appendChild(form);
    form.submit();
    form.remove();
  }, [src, postKey, sandbox]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { postMsg({ type: 'selectMode', on: selectMode }); }, [selectMode, postMsg]);
  useEffect(() => { postMsg({ type: 'highlight', region: selectedRegion }); }, [selectedRegion, postMsg]);

  const bindingKey = bindings.map((b) => `${b.id}:${b.kind}`).join(',');
  const filterKey = filters.map((f) => `${f.key}:${f.kind}`).join(',');
  useEffect(() => {
    if (!portRef.current) return;
    const keys = new Set(filters.map((f) => f.key));
    stateRef.current = Object.fromEntries(Object.entries(stateRef.current).filter(([k]) => keys.has(k)));
    pushContext();
    void loadAll();
  }, [bindingKey, filterKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!sandbox) {
    return (
      <div className={`flex items-center justify-center bg-surface-1 p-6 text-center text-sm text-red-600 ${className || ''}`} data-testid="report-frame-refused">
        Không mở báo cáo: tài liệu báo cáo phải được phục vụ từ một origin riêng, khác origin của AppBI.
      </div>
    );
  }
  if (blocked) {
    return (
      <div className={`flex items-center justify-center bg-surface-1 text-sm text-text-secondary ${className || ''}`} data-testid="report-frame-blocked">
        Báo cáo đã bị chặn vì cố điều hướng ra ngoài. Tải lại trang để mở lại.
      </div>
    );
  }
  return (
    <iframe
      key={src + (post ? ':post' : '')}
      ref={frameRef}
      name={`rac-frame-${frameName}`}
      src={post ? undefined : src}
      title={title || 'Report'}
      sandbox={sandbox}
      referrerPolicy="no-referrer"
      allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'; clipboard-read 'none'; display-capture 'none'"
      onLoad={handleLoad}
      className={className}
      data-testid="report-frame"
      style={{ border: 0, display: 'block', width: '100%', height: '100%', background: 'transparent' }}
    />
  );
}
