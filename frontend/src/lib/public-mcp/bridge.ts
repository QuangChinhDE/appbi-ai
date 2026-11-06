/**
 * The viewer's side of the Report UI Bridge (Public Read MCP).
 *
 * This tab pairs with AppBI (`publicMcpApi.pair`, the public client: same proof as viewing
 * the link), hands the link-bound grant to the public MCP service, and from then on:
 *  - reports what the viewer sees (page, filters, focused chart, drill) — `state`;
 *  - long-polls the commands the viewer's Claude sent to THIS tab and applies them
 *    through the page's own controls, acknowledging each one.
 *
 * The browser secret lives in memory only (never storage, never a URL). No AppBI
 * credential is involved: it talks to the MCP service with `credentials: 'omit'`.
 * Every command was validated by AppBI before it arrived; every data read is
 * re-checked by AppBI anyway, so a tampered tab can only mislead itself.
 */
import { publicMcpApi } from '@/lib/api/public';

export type BridgeCommand =
  | { id: number; type: 'set_filters'; filters?: Record<string, unknown>; viewer_filters?: Array<Record<string, unknown>> }
  | { id: number; type: 'reset_filters' }
  | { id: number; type: 'go_to_page'; page: string }
  | { id: number; type: 'focus'; chart: string }
  | { id: number; type: 'drill'; chart_id: number; field: string; value: unknown }
  | { id: number; type: 'clear_drill' };

export type ApplyResult = { ok: boolean; error?: string };

export interface BridgeSession {
  sessionId: string;
  pairCode: string;
  pairExpiresAt: number;
  connectorUrl: string;
  reportName: string;
}

export type BridgeStatus = 'idle' | 'starting' | 'waiting' | 'connected' | 'ended' | 'error';

interface Handlers {
  apply: (cmd: BridgeCommand) => Promise<ApplyResult> | ApplyResult;
  getState: () => Record<string, unknown>;
  onStatus: (s: BridgeStatus, detail?: string) => void;
  onCommand?: (cmd: BridgeCommand, result: ApplyResult) => void;
}

function base(mcpBase: string): string {
  return `${(mcpBase || (typeof window !== 'undefined' ? window.location.origin : '')).replace(/\/$/, '')}/public-mcp`;
}

export class ReportBridge {
  private secret = '';
  private sid = '';
  private root = '';
  private stopped = false;
  private after = 0;
  private lastSent = '';
  session: BridgeSession | null = null;

  constructor(private h: Handlers) {}

  async start(kind: 'dashboard' | 'report', token: string, sessionToken?: string | null): Promise<BridgeSession> {
    this.h.onStatus('starting');
    const paired = await publicMcpApi.pair(kind, token, sessionToken);
    this.root = base(paired.mcp_base);
    const r = await fetch(`${this.root}/bridge/sessions`, {
      method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant: paired.grant }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body?.message || body?.error || `HTTP ${r.status}`);
    this.secret = body.browser_secret;
    this.sid = body.session_id;
    this.session = {
      sessionId: body.session_id, pairCode: body.pair_code, pairExpiresAt: Date.now() + body.pair_expires_in * 1000,
      connectorUrl: body.connector_url, reportName: body.report?.name || paired.report?.name || '',
    };
    this.h.onStatus('waiting');
    await this.pushState(true);
    void this.loop();
    return this.session;
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'X-Bridge-Secret': this.secret };
  }

  async pushState(force = false, ack?: { id: number; ok: boolean; error?: string }): Promise<void> {
    if (!this.sid || this.stopped) return;
    const state = this.h.getState();
    const raw = JSON.stringify(state);
    if (!force && !ack && raw === this.lastSent) return;
    this.lastSent = raw;
    await fetch(`${this.root}/bridge/sessions/${this.sid}/state`, {
      method: 'POST', credentials: 'omit', headers: this.headers(), body: JSON.stringify({ state, ack }),
    }).catch(() => undefined);
  }

  async newCode(): Promise<void> {
    if (!this.session) return;
    const r = await fetch(`${this.root}/bridge/sessions/${this.sid}/code`, { method: 'POST', credentials: 'omit', headers: this.headers() });
    if (!r.ok) return;
    const b = await r.json();
    this.session = { ...this.session, pairCode: b.pair_code, pairExpiresAt: Date.now() + b.pair_expires_in * 1000 };
  }

  private async loop(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      try {
        const r = await fetch(`${this.root}/bridge/sessions/${this.sid}/commands?after=${this.after}`, {
          credentials: 'omit', headers: this.headers(),
        });
        if (r.status === 410) { this.stopped = true; this.h.onStatus('ended'); return; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        failures = 0;
        const b = await r.json();
        this.h.onStatus(b.claude_connected ? 'connected' : 'waiting');
        for (const cmd of (b.commands || []) as BridgeCommand[]) {
          this.after = Math.max(this.after, cmd.id);
          let res: ApplyResult;
          try { res = await this.h.apply(cmd); } catch (e: any) { res = { ok: false, error: String(e?.message || e).slice(0, 200) }; }
          // let the page settle so the reported state is the one the viewer now sees
          await new Promise((ok) => setTimeout(ok, 400));
          await this.pushState(true, { id: cmd.id, ok: res.ok, error: res.error });
          this.h.onCommand?.(cmd, res);
        }
      } catch (e: any) {
        failures += 1;
        if (failures > 5) { this.h.onStatus('error', String(e?.message || e)); }
        await new Promise((ok) => setTimeout(ok, Math.min(10_000, 1000 * failures)));
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopped || !this.sid) return;
    this.stopped = true;
    await fetch(`${this.root}/bridge/sessions/${this.sid}/end`, {
      method: 'POST', credentials: 'omit', headers: this.headers(), keepalive: true,
    }).catch(() => undefined);
    this.h.onStatus('ended');
  }
}
