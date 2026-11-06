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
  previewKey,
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
  /** Studio: outline what the BI Core supplies vs numbers the code writes itself. */
  provenance?: boolean;
  /** Bring a binding's block into view (n changes per request, so the same id can be asked twice). */
  focus?: { id: string; n: number } | null;
  selectedRegion?: string | null;
  onRegionSelected?: (region: string) => void;
  onIssue?: (issue: RuntimeIssue) => void;
  onStateChange?: (state: FilterState) => void;
  className?: string;
  title?: string;
}

// The same bound as a Manual dashboard's tiles (PublicDashboardView CHART_FETCH_CONCURRENCY).
const PARALLEL = 8;
/** A DTO is reused for this long by the SAME frame owner (same fetcher = same report, revision
 *  and caller): an unsaved-code preview re-renders the document, not the data. */
const DTO_TTL_MS = 60_000;

/** How long a report document may take to say "ready" before the frame says it failed. */
const FRAME_READY_TIMEOUT_MS = 15_000;
/** When each document started waiting for "ready" - kept OUTSIDE the component, so a host
 *  that re-mounts the frame (a parent re-render) does not restart the wait forever. */
const waitingSince = new Map<string, number>();

export function ReportFrame({
  src, post, isolated = false, onGuard, bindings, filters, fetchData, fetchValues, mode = 'view', selectMode = false,
  provenance = false, focus = null, selectedRegion = null,
  onRegionSelected, onIssue, onStateChange, className, title,
}: ReportFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const portRef = useRef<MessagePort | null>(null);
  const loadsRef = useRef(0);
  const stateRef = useRef<FilterState>({});
  const seqRef = useRef<Record<string, number>>({});
  const propsRef = useRef({ bindings, filters, fetchData, fetchValues, onRegionSelected, onIssue, onStateChange, onGuard, mode, provenance, src });
  propsRef.current = { bindings, filters, fetchData, fetchValues, onRegionSelected, onIssue, onStateChange, onGuard, mode, provenance, src };
  const [blocked, setBlocked] = useState(false);
  // The document never said "ready": unreachable origin (a report origin pointing at the
  // viewer's own machine), a proxy that does not route it, a crash. Said, not a blank box.
  const [stalled, setStalled] = useState(false);
  const readyRef = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const attemptRef = useRef(0);
  // binding|state -> {at, dto | in-flight promise}; dropped when the fetcher, the bindings or
  // the filters change (a different revision, caller or data contract is never served from it).
  const valuesCacheRef = useRef<{ owner: unknown; map: Map<string, { at: number; p: Promise<unknown[]> }> }>({ owner: null, map: new Map() });
  const dtoCacheRef = useRef<{ owner: unknown; key: string; map: Map<string, { at: number; p: Promise<unknown> }> }>({ owner: null, key: '', map: new Map() });
  const [frameName] = useState(() => Math.random().toString(36).slice(2));

  const postMsg = useCallback((msg: unknown) => { portRef.current?.postMessage(msg); }, []);

  const pushContext = useCallback(() => {
    const p = propsRef.current;
    postMsg({ type: 'context', filters: p.filters, state: stateRef.current, bindings: p.bindings, mode: p.mode, locale: 'vi-VN' });
  }, [postMsg]);

  const loadAll = useCallback(async () => {
    const { bindings: list, fetchData: fetcher, filters: decl } = propsRef.current;
    const state = stateRef.current;
    const cache = dtoCacheRef.current;
    const contract = list.map((b) => `${b.id}:${b.kind}`).join(',') + '|' + decl.map((f) => `${f.key}:${f.kind}:${f.grain || ''}:${f.default || ''}:${f.default_value || ''}`).join(',');
    if (cache.owner !== fetcher || cache.key !== contract) { cache.owner = fetcher; cache.key = contract; cache.map = new Map(); }
    const stateKey = JSON.stringify(Object.keys(state).sort().map((k) => [k, state[k]]));
    const fetchOnce = (id: string): Promise<unknown> => {
      const k = `${id}|${stateKey}`;
      const hit = cache.map.get(k);
      if (hit && Date.now() - hit.at < DTO_TTL_MS) return hit.p;
      const p = fetcher(id, state).catch((e: any) => {
        cache.map.delete(k); // an error is never cached
        return { bindingId: id, status: 'error', error: e?.response?.data?.detail || 'Không tải được dữ liệu', rows: [], fields: [] };
      });
      cache.map.set(k, { at: Date.now(), p });
      return p;
    };
    const queue = [...list];
    const worker = async () => {
      for (let b = queue.shift(); b; b = queue.shift()) {
        const id = b.id;
        const seq = (seqRef.current[id] = (seqRef.current[id] || 0) + 1);
        const dto = await fetchOnce(id);
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
        readyRef.current = true;
        waitingSince.delete(`${propsRef.current.src}#${attemptRef.current}`);
        setStalled(false);
        p.onGuard?.({ guard: msg.guard, authorScript: msg.authorScript });
        pushContext();
        if (p.provenance) postMsg({ type: 'provenance', on: true });
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
        // A picker re-mounts when the state its numbers carry arrives; the same list is asked
        // again. Same owner + filters + state + search = the same answer (shared, short-lived).
        const vc = valuesCacheRef.current;
        if (vc.owner !== p.fetchValues) { vc.owner = p.fetchValues; vc.map = new Map(); }
        const st = stateRef.current;
        const vk = `${msg.key}|${msg.search}|${JSON.stringify(Object.keys(st).sort().map((k) => [k, st[k]]))}|${p.filters.map((f) => `${f.key}:${f.grain || ''}:${f.default || ''}`).join(',')}`;
        let hit = vc.map.get(vk);
        if (!hit || Date.now() - hit.at >= DTO_TTL_MS) {
          const pr = p.fetchValues(msg.key, msg.search, st).catch(() => { vc.map.delete(vk); return [] as unknown[]; });
          hit = { at: Date.now(), p: pr };
          vc.map.set(vk, hit);
        }
        const values = await hit.p;
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

  // Every byte of the unsaved source decides a re-post (a same-length CSS/JS edit included).
  const postKey = previewKey(post);
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
  }, [src, postKey, sandbox, attempt, stalled]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { postMsg({ type: 'selectMode', on: selectMode }); }, [selectMode, postMsg]);
  useEffect(() => { postMsg({ type: 'provenance', on: provenance }); }, [provenance, postMsg]);
  useEffect(() => { if (focus) postMsg({ type: 'focus', id: focus.id }); }, [focus, postMsg]);
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

  useEffect(() => {
    readyRef.current = false;
    attemptRef.current = attempt;
    const key = `${src}#${attempt}`;
    if (!waitingSince.has(key)) waitingSince.set(key, Date.now());
    const left = Math.max(0, FRAME_READY_TIMEOUT_MS - (Date.now() - (waitingSince.get(key) || Date.now())));
    const timer = setTimeout(() => { if (!readyRef.current) setStalled(true); }, left);
    return () => clearTimeout(timer);
  }, [src, attempt]);

  if (!sandbox) {
    return (
      <div className={`flex items-center justify-center bg-surface-1 p-6 text-center text-sm text-red-600 ${className || ''}`} data-testid="report-frame-refused">
        Không mở báo cáo: tài liệu báo cáo phải được phục vụ từ một origin riêng, khác origin của AppBI.
      </div>
    );
  }
  if (stalled) {
    let where = src;
    try { where = new URL(src, appOrigin).origin; } catch { /* relative */ }
    return (
      <div className={`flex flex-col items-center justify-center gap-2 bg-surface-1 p-6 text-center text-sm text-text-secondary ${className || ''}`} data-testid="report-frame-stalled" role="alert">
        <div className="font-medium text-red-600">Không tải được khung báo cáo.</div>
        <div className="max-w-md text-xs">Tài liệu báo cáo được phục vụ từ <code className="rounded bg-surface-2 px-1">{where}</code> nhưng không phản hồi. Nếu địa chỉ này là 127.0.0.1/localhost trên máy chủ, cần cấu hình REPORT_ARTIFACT_ORIGIN.</div>
        <button type="button" className="mt-1 rounded-md border border-stroke-strong px-3 py-1 text-xs hover:bg-surface-2" data-testid="report-frame-retry"
          onClick={() => { readyRef.current = false; loadsRef.current = 0; portRef.current?.close(); portRef.current = null; setStalled(false); setAttempt((n) => n + 1); }}>Thử lại</button>
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
      key={src + (post ? ':post' : '') + ':' + attempt}
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
