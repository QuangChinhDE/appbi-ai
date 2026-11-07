/* AppBI Report Runtime (rac) v1 — runs FIRST inside the sandboxed report frame.
 *
 * The frame has an opaque origin (sandbox without allow-same-origin) and a CSP with
 * connect-src 'none'. Data only ever arrives over a MessagePort the host hands over
 * once; this file is the only code that touches that port. Everything a report does
 * with data goes through `window.rac`.
 */
(function () {
  'use strict';
  var VERSION = '1.1.0';
  var authorState = 'none';

  // ── 1. Lock down what a report has no business using ────────────────────────────
  // CSP already refuses network access; removing the APIs as well makes a mistake fail
  // loudly (with a message the author can act on) instead of silently.
  var errors = [];
  function blocked(name) {
    return function () {
      report('blocked', name + ' is not available in an AppBI report — data arrives through rac.bind().');
      throw new Error('AppBI sandbox: ' + name + ' is not available in a report.');
    };
  }
  ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'RTCPeerConnection', 'webkitRTCPeerConnection',
    'RTCDataChannel', 'Worker', 'SharedWorker', 'BroadcastChannel', 'open'].forEach(function (n) {
    try { Object.defineProperty(window, n, { value: blocked(n), writable: false, configurable: false }); } catch (e) { /* already locked */ }
  });
  try { Object.defineProperty(Navigator.prototype, 'sendBeacon', { value: blocked('sendBeacon'), configurable: false }); } catch (e) { /* noop */ }
  var FORBIDDEN_TAGS = { IFRAME: 1, FRAME: 1, OBJECT: 1, EMBED: 1, BASE: 1, LINK: 1, META: 1, PORTAL: 1 };
  function scrub(node) {
    if (!node || node.nodeType !== 1) return;
    if (FORBIDDEN_TAGS[node.tagName]) { report('blocked', '<' + node.tagName.toLowerCase() + '> removed'); node.remove(); return; }
    var kids = node.querySelectorAll ? node.querySelectorAll('iframe,frame,object,embed,base,link,meta,portal') : [];
    for (var i = 0; i < kids.length; i++) { report('blocked', '<' + kids[i].tagName.toLowerCase() + '> removed'); kids[i].remove(); }
  }
  new MutationObserver(function (muts) {
    muts.forEach(function (m) { for (var i = 0; i < m.addedNodes.length; i++) scrub(m.addedNodes[i]); });
    scheduleMount();
  }).observe(document.documentElement, { childList: true, subtree: true });
  // Storage: every report shares one report origin, so nothing may persist there.
  ['localStorage', 'sessionStorage', 'indexedDB', 'caches', 'cookieStore'].forEach(function (n) {
    try { Object.defineProperty(window, n, { get: blocked(n), configurable: false }); } catch (e) { /* noop */ }
  });
  try { Object.defineProperty(navigator, 'serviceWorker', { get: blocked('serviceWorker'), configurable: false }); } catch (e) { /* noop */ }
  try { Object.defineProperty(document, 'cookie', { get: function () { return ''; }, set: blocked('document.cookie'), configurable: false }); } catch (e) { /* noop */ }

  // Navigation guard. A navigation is the one channel CSP cannot close (the URL
  // itself carries data), so it is CANCELLED before any request is made. The
  // Navigation API fires `navigate` before the fetch; this listener is registered
  // before any report code exists, so it always runs first and its preventDefault
  // cannot be undone. The guard proves itself with a same-document navigation;
  // without that proof report code is never executed.
  var guard = false, guardInstalled = false, selfTest = false;
  try {
    var nav = window.navigation;
    if (nav && typeof nav.addEventListener === 'function') {
      guardInstalled = true;
      nav.addEventListener('navigate', function (e) {
        var sameDoc = e.hashChange || (e.destination && e.destination.sameDocument);
        if (e.destination && /#rac-guard-selftest$/.test(e.destination.url)) selfTest = true;
        if (sameDoc) return;
        if (e.cancelable) e.preventDefault();
        report('blocked', 'Navigation to ' + String(e.destination && e.destination.url).slice(0, 80) + ' was cancelled before it was sent.');
      });
      nav.navigate('#rac-guard-selftest', { history: 'replace' });
    }
  } catch (e) { guardInstalled = false; }
  function settleGuard() {
    guard = guardInstalled && selfTest;
    if (selfTest) { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* noop */ } }
    return guard;
  }

  // A report navigates inside itself (#anchors); it never leaves the frame.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (href.charAt(0) === '#') return;
    e.preventDefault();
    report('blocked', 'link to ' + href.slice(0, 80) + ' blocked');
  }, true);

  // ── 2. The channel ─────────────────────────────────────────────────────────────
  var port = null;
  var outbox = [];
  var ctx = { filters: [], state: {}, bindings: [], mode: 'view', locale: 'vi-VN' };
  var cache = {};      // binding id -> dto
  var subs = {};       // binding id -> [fn]
  var filterSubs = [];
  var readySubs = [];
  var pending = {};    // values request id -> resolve
  var reqSeq = 0;

  function send(msg) { if (port) port.postMessage(msg); else outbox.push(msg); }
  function report(kind, message) {
    var entry = { type: 'error', kind: kind, message: String(message || '').slice(0, 500) };
    errors.push(entry);
    send(entry);
  }
  window.addEventListener('error', function (e) {
    report('script', (e.message || 'Script error') + (e.lineno ? ' (line ' + e.lineno + ')' : ''));
  });
  window.addEventListener('unhandledrejection', function (e) {
    report('script', 'Unhandled promise rejection: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason)));
  });

  window.addEventListener('message', function (e) {
    if (port || e.source !== window.parent || !e.data || e.data.type !== 'rac:init' || !e.ports || !e.ports[0]) return;
    port = e.ports[0];
    port.onmessage = function (ev) { try { onHost(ev.data || {}); } catch (err) { report('runtime', err && err.message); } };
    applyContext(e.data.context || {});
    var queued = outbox; outbox = [];
    queued.forEach(send);
    var nd = needed(); lastNeed = nd.key;
    send({ type: 'ready', version: VERSION, guard: settleGuard(), authorScript: authorState, need: nd.ids, limits: nd.limits });
    watchNeed();
    readySubs.forEach(function (fn) { safe(fn); });
  });

  function applyContext(c) {
    if (Array.isArray(c.filters)) ctx.filters = c.filters;
    if (c.state && typeof c.state === 'object') ctx.state = c.state;
    if (Array.isArray(c.bindings)) ctx.bindings = c.bindings;
    if (c.mode) ctx.mode = c.mode;
    if (c.locale) ctx.locale = c.locale;
    document.documentElement.setAttribute('data-rac-mode', ctx.mode);
  }

  function onHost(msg) {
    switch (msg.type) {
      case 'context':
        applyContext(msg);
        filterSubs.forEach(function (fn) { safe(fn, ctx.state); });
        renderAll();
        break;
      case 'data':
        if (typeof msg.id !== 'string' || !msg.dto) return;
        cache[msg.id] = msg.dto;
        if (msg.dto.state && typeof msg.dto.state === 'object') {
          var st = msg.dto.state, changed = false;
          Object.keys(st).forEach(function (k) { if (JSON.stringify(applied[k]) !== JSON.stringify(st[k])) { applied[k] = st[k]; changed = true; } });
          if (changed) renderFilterBound();
        }
        (subs[msg.id] || []).forEach(function (fn) { safe(fn, msg.dto); });
        renderBinding(msg.id);
        checkOverflow();
        auditNumbers();
        if (ctx.mode === 'studio' && msg.dto.notApplied && msg.dto.notApplied.length && Object.keys(ctx.state || {}).length) {
          var nk = 'f:' + msg.id + ':' + msg.dto.notApplied.join(',');
          if (!auditSeen[nk]) {
            auditSeen[nk] = 1;
            report('filter', 'Bộ lọc ' + msg.dto.notApplied.join(', ') + ' không áp dụng được cho "' + (msg.dto.title || msg.id) +
              '" (semantic model không nối được) — phần này đang hiển thị số chưa lọc.');
          }
        }
        break;
      case 'values':
        if (pending[msg.reqId]) { pending[msg.reqId](Array.isArray(msg.values) ? msg.values : []); delete pending[msg.reqId]; }
        break;
      case 'selectMode':
        document.body.classList.toggle('rac-select', !!msg.on);
        break;
      case 'focus':
        // "show this chart" from the viewer's AI Bot: the block that draws this binding
        // A binding can be drawn more than once (a KPI and its chart, a table below):
        // scroll to the first VISIBLE block that draws it (a chart before a number in a
        // sentence) and flash every block that shows it.
        if (msg.region && !msg.id) {
          // a section of the page (the viewer's Claude: "go to the Revenue section")
          var reg = document.querySelector('[data-rac-region="' + cssEsc(String(msg.region)) + '"]');
          if (reg) {
            reg.scrollIntoView({ block: 'start', behavior: 'smooth' });
            reg.classList.add('rac-flash');
            setTimeout(function () { reg.classList.remove('rac-flash'); }, 1600);
          }
        }
        if (msg.id) {
          var q = cssEsc(String(msg.id));
          var all = Array.prototype.slice.call(document.querySelectorAll('[data-rac-bind="' + q + '"]'))
            .concat(Array.prototype.slice.call(document.querySelectorAll('[data-rac-value="' + q + '"]')));
          var boxes = [];
          for (var k = 0; k < all.length; k++) {
            var bx = all[k].closest('.card,[data-rac-region]') || all[k];
            if (boxes.indexOf(bx) < 0) boxes.push(bx);
          }
          var first = null;
          for (var v = 0; v < boxes.length && !first; v++) if (boxes[v].getClientRects().length) first = boxes[v];
          first = first || boxes[0];
          if (first) {
            first.scrollIntoView({ block: 'center', behavior: 'smooth' });
            boxes.forEach(function (b) { b.classList.add('rac-flash'); });
            setTimeout(function () { boxes.forEach(function (b) { b.classList.remove('rac-flash'); }); }, 1600);
          }
        }
        break;
      case 'provenance':
        // Studio overlay: what the BI Core supplies (solid green) vs a number the code
        // itself writes that matches no bound value (dashed amber, from the audit below).
        document.body.classList.toggle('rac-prov', !!msg.on);
        break;
      case 'highlight':
        var prev = document.querySelectorAll('.rac-selected');
        for (var i = 0; i < prev.length; i++) prev[i].classList.remove('rac-selected');
        if (msg.region) {
          var el = document.querySelector('[data-rac-region="' + cssEsc(msg.region) + '"]');
          if (el) { el.classList.add('rac-selected'); el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
        }
        break;
      default:
        break;
    }
  }

  document.addEventListener('click', function (e) {
    if (!document.body.classList.contains('rac-select')) return;
    var el = e.target && e.target.closest ? e.target.closest('[data-rac-region]') : null;
    if (!el) return;
    e.preventDefault(); e.stopPropagation();
    send({ type: 'region', region: el.getAttribute('data-rac-region') });
  }, true);

  function safe(fn, arg) { try { fn(arg); } catch (err) { report('script', err && err.message ? err.message : String(err)); } }
  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  // ── 3. Formatting ──────────────────────────────────────────────────────────────
  function num(v) { var n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : null; }
  function fmt(v, field, opts) {
    opts = opts || {};
    var n = num(v);
    if (n === null) return v === null || v === undefined || v === '' ? '—' : String(v);
    var f = (field && field.format) || {};
    // The platform's percent convention (ExploreChart / report-findings): a measure whose
    // SEMANTIC format is percent holds a RATIO and is shown x100. A "%" that only the design
    // writes (opts.kind) is a sign: the number is shown as the BI Core returned it. Decided
    // by the model, never by the size of the value.
    var semPct = f.kind === 'percent';
    var kind = semPct ? 'percent' : (opts.kind === 'percent' ? 'sign' : (opts.kind || f.kind || 'number'));
    var compact = opts.compact !== undefined ? opts.compact : Math.abs(n) >= 10000;
    var decimals = opts.decimals !== undefined ? opts.decimals : (f.decimals !== undefined && f.decimals !== null ? f.decimals : null);
    if (kind === 'percent' || kind === 'sign') {
      var p = kind === 'percent' ? n * 100 : n;
      var pd = decimals === null ? 1 : decimals;
      return p.toLocaleString(ctx.locale, { minimumFractionDigits: opts.decimals !== undefined ? pd : 0, maximumFractionDigits: pd }) + '%' + (opts.suffix || '');
    }
    if (num(opts.scale) !== null && num(opts.scale) !== 0) {
      // the design's own unit ("79,65 tỷ" = value / 1e9, 2 decimals): same number, authored look
      var sd = decimals === null ? 2 : decimals;
      return (n / num(opts.scale)).toLocaleString(ctx.locale, { minimumFractionDigits: sd, maximumFractionDigits: sd }) + (opts.suffix || '');
    }
    var o = { maximumFractionDigits: decimals === null ? (compact ? 1 : (Math.abs(n) < 100 ? 2 : 0)) : decimals };
    if (compact) o.notation = 'compact';
    var s;
    try { s = n.toLocaleString(ctx.locale, o); } catch (e) { s = String(Math.round(n * 100) / 100); }
    if (kind === 'currency') {
      var code = f.currency || f.symbol || '';
      if (code === 'VND' || code === '₫') return s + ' ₫';
      if (code === 'USD' || code === '$') return '$' + s;
      if (code === 'BRL' || code === 'R$') return 'R$ ' + s;
      return code ? s + ' ' + code : s;
    }
    return s;
  }
  var MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
  function fmtDate(v, grain) {
    if (v === null || v === undefined) return '—';
    var s = String(v);
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return s;
    switch (grain) {
      case 'year': return m[1];
      case 'quarter': return 'Q' + (Math.floor((parseInt(m[2], 10) - 1) / 3) + 1) + ' ' + m[1];
      case 'month': return MONTHS[parseInt(m[2], 10) - 1] + '/' + m[1];
      case 'week': return m[3] + '/' + m[2];
      default: return m[3] + '/' + m[2] + '/' + m[1];
    }
  }
  function label(v, field) {
    if (field && field.kind === 'date') return fmtDate(v, field.grain);
    if (field && field.role === 'measure') return fmt(v, field);
    return v === null || v === undefined || v === '' ? '(trống)' : String(v);
  }

  // ── 4. DTO helpers ─────────────────────────────────────────────────────────────
  function dtoOf(src) { return typeof src === 'string' ? cache[src] || null : src || null; }
  function dims(d) { return ((d && d.fields) || []).filter(function (f) { return f.role !== 'measure'; }); }
  function measures(d) { return ((d && d.fields) || []).filter(function (f) { return f.role === 'measure'; }); }
  function field(d, key) { var fs = (d && d.fields) || []; for (var i = 0; i < fs.length; i++) if (fs[i].key === key) return fs[i]; return null; }
  function additive(f) { var a = String((f && f.aggregation) || '').toLowerCase(); return a === 'sum' || a === 'count'; }
  function primary(d, opts) {
    opts = opts || {};
    var m = opts.field ? field(d, opts.field) : measures(d)[0];
    var dim = dims(d)[0];
    var rows = (d && d.rows) || [];
    if (!m || !rows.length) return { value: null, field: m, prev: null, note: '' };
    // One value = the BI Core's result for the whole filter context (a KPI binding).
    if (rows.length === 1 || !dim) return { value: rows[0][m.key], field: m, prev: null, note: '' };
    if (dim.kind === 'date') {
      // The latest period's value, as the BI Core aggregated it (a selection, not a sum).
      // `prev` is the BI Core's value of the period before; a change computed from the
      // two is a REPORT calculation (derived), never shown for an incomplete period.
      var last = rows[rows.length - 1], before = rows.length > 1 ? rows[rows.length - 2] : null;
      var part = (d.partial || []).indexOf(String(last[dim.key])) >= 0;
      return { value: last[m.key], prev: before && !part ? before[m.key] : null, field: m, partial: part,
        note: fmtDate(last[dim.key], dim.grain) + (part ? ' (chưa trọn kỳ)' : '') };
    }
    // Many rows and no time axis: a total or "the" value is NOT something the report adds up
    // or picks. Bind a KPI (the BI Core computes it) or address a row (data-rac-row/-rank).
    return { value: null, field: m, prev: null, note: '', needsKpi: true };
  }
  var kpiNoted = {};
  function needsKpi(el, d, m) {
    var k = (d && d.bindingId) + ':' + (m ? m.key : '');
    if (!kpiNoted[k]) {
      kpiNoted[k] = 1;
      report('provenance', 'Nguồn "' + ((d && d.title) || '') + '" có nhiều dòng: một con số tổng phải do BI Core tính — gắn một binding KPI, '
        + 'hoặc chọn một dòng bằng data-rac-row / data-rac-rank. Báo cáo không tự cộng.');
    }
    el.setAttribute('data-rac-prov', 'needs-kpi');
  }
  // What a reader must know about the rows: a Top-N chart or a cut result is not the whole.
  function cutNote(d) {
    if (!d) return '';
    if (d.topN && d.topN.n) return (d.topN.direction === 'bottom' ? 'Chỉ ' : 'Top ') + d.topN.n + (d.topN.direction === 'bottom' ? ' dòng thấp nhất' : ' theo biểu đồ nguồn');
    if (d.truncated) return 'Hiển thị ' + (d.rows || []).length + ' dòng đầu';
    return '';
  }
  function cutBadge(el, d) {
    var t = cutNote(d);
    if (!t || !el || !el.parentNode) return;
    var b = document.createElement('div'); b.className = 'rac-note rac-cut'; b.setAttribute('data-rac-prov', 'cut'); b.textContent = t;
    el.appendChild(b);
  }
  function provTitle(d, m) {
    if (!d) return '';
    var p = d.provenance || {};
    var parts = [];
    if (m) parts.push(m.label + (m.aggregation ? ' · ' + m.aggregation.toUpperCase() : ''));
    if (p.source) parts.push(p.source);
    if (p.asOf) parts.push('Dữ liệu lúc ' + String(p.asOf).replace('T', ' ').slice(0, 16));
    if (d.notApplied && d.notApplied.length) parts.push('Bộ lọc không áp dụng: ' + d.notApplied.join(', '));
    var cut = cutNote(d); if (cut) parts.push(cut);
    return parts.join('\n');
  }

  // ── 5. SVG kit ─────────────────────────────────────────────────────────────────
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function cssVar(name, fallback) { var v = getComputedStyle(document.documentElement).getPropertyValue(name); return v && v.trim() ? v.trim() : fallback; }
  var DEFAULT_PALETTE = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#f97316'];
  function palette() { var out = []; for (var i = 0; i < 8; i++) out.push(cssVar('--rac-c' + (i + 1), DEFAULT_PALETTE[i])); return out; }
  function niceMax(v) {
    if (!(v > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v))), r = v / p;
    return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * p;
  }
  function size(el, h) {
    var w = Math.max(160, Math.floor(el.clientWidth || el.getBoundingClientRect().width || 320));
    var hh = h || Math.max(140, Math.floor(el.clientHeight || 0)) || 240;
    return { w: w, h: hh };
  }
  function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  var tip = null;
  function showTip(e, html) {
    if (!tip) { tip = document.createElement('div'); tip.className = 'rac-tip'; document.body.appendChild(tip); }
    tip.innerHTML = html; tip.style.display = 'block';
    var x = e.clientX + 14, y = e.clientY + 14, r = tip.getBoundingClientRect();
    if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - 14;
    if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - 14;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  function hideTip() { if (tip) tip.style.display = 'none'; }
  function tipHtml(title, rows) {
    return '<div class="rac-tip-t">' + esc(title) + '</div>' + rows.map(function (r) {
      return '<div class="rac-tip-r"><span class="rac-tip-dot" style="background:' + esc(r.color || 'var(--rac-accent)') + '"></span>' + esc(r.label) + '<b>' + esc(r.value) + '</b></div>';
    }).join('');
  }
  // A place whose binding the report does not have ("missing" left by an import, a deleted
  // binding) or that the server says is not bound: said on the tile, never an empty box.
  function unbound(id, d) {
    if (d && d.status === 'unbound') return true;
    if (!id || id === 'missing') return true;
    return !d && ctx.bindings.length > 0 && !ctx.bindings.some(function (b) { return b.id === id; });
  }
  var UNBOUND_HTML = '<div class="rac-state rac-unbound" data-rac-prov="unbound" title="Vị trí này chưa được nối với dữ liệu BI Core">Chưa gắn dữ liệu</div>';
  function stateBox(el, d) {
    if (d && d.status === 'unbound') { el.innerHTML = UNBOUND_HTML; return true; }
    if (!d || d.status === 'loading') { el.innerHTML = '<div class="rac-skel"></div>'; return true; }
    if (d.status === 'error' || d.status === 'refused') { el.innerHTML = '<div class="rac-state rac-error">' + esc(d.error || 'Không tải được dữ liệu') + '</div>'; return true; }
    if (!d.rows || !d.rows.length) { el.innerHTML = '<div class="rac-state">Không có dữ liệu cho bộ lọc hiện tại</div>'; return true; }
    return false;
  }
  function activeValues(d) {
    var dim = dims(d)[0];
    if (!dim || !dim.filterKey) return null;
    var v = ctx.state[dim.filterKey];
    return Array.isArray(v) && v.length ? v.map(String) : null;
  }
  function bindDrill(el, d) {
    var dim = dims(d)[0];
    if (!dim || !dim.filterKey) return;
    var marks = el.querySelectorAll('[data-rac-v]');
    for (var i = 0; i < marks.length; i++) {
      marks[i].style.cursor = 'pointer';
      marks[i].addEventListener('click', function (ev) {
        ev.stopPropagation();
        api.drill(dim.filterKey, this.getAttribute('data-rac-v'));
      });
    }
  }

  var viz = {};

  viz.kpi = function (el, d, opts) {
    opts = opts || {};
    if (stateBox(el, d)) return;
    var p = primary(d, opts);
    var m = p.field;
    if (p.needsKpi) needsKpi(el, d, m);
    var lbl = opts.label || (m && m.label) || d.title || '';
    var deltaHtml = '';
    var cur = num(p.value), prev = num(p.prev);
    if (opts.compare !== 'none' && cur !== null && prev !== null && prev !== 0) {
      var pct = (cur - prev) / Math.abs(prev) * 100;
      var up = pct >= 0;
      var good = opts.goal === 'down' ? !up : up;
      deltaHtml = '<span class="rac-kpi-delta rac-derived ' + (opts.goal ? (good ? 'pos' : 'neg') : 'neu') + '" data-rac-prov="derived" title="Tính trong báo cáo từ hai kỳ BI Core trả về — không phải metric chính thức">' + (up ? '▲' : '▼') + ' ' +
        Math.abs(pct).toLocaleString(ctx.locale, { maximumFractionDigits: 1 }) + '%</span><span class="rac-kpi-cmp">so với kỳ trước · tính trong báo cáo</span>';
    }
    var spark = '';
    var dim = dims(d)[0];
    if (opts.sparkline !== false && dim && dim.kind === 'date' && d.rows.length > 2) spark = '<div class="rac-kpi-spark"></div>';
    el.innerHTML = '<div class="rac-kpi" title="' + esc(provTitle(d, m)) + '" data-rac-prov="' + esc(d.bindingId || '') + '">' +
      '<div class="rac-kpi-label">' + esc(lbl) + '</div>' +
      '<div class="rac-kpi-value">' + esc(fmt(p.value, m, opts)) + '</div>' +
      '<div class="rac-kpi-foot">' + deltaHtml + (p.note ? '<span class="rac-kpi-note">' + esc(p.note) + '</span>' : '') + '</div>' + spark + '</div>';
    if (spark) viz.sparkline(el.querySelector('.rac-kpi-spark'), d, { height: 36 });
  };

  viz.sparkline = function (el, d, opts) {
    opts = opts || {};
    if (!d || !d.rows || !d.rows.length) { el.innerHTML = ''; return; }
    var m = opts.field ? field(d, opts.field) : measures(d)[0];
    if (!m) return;
    var s = size(el, opts.height || 40), vals = d.rows.map(function (r) { return num(r[m.key]) || 0; });
    var mx = Math.max.apply(null, vals), mn = Math.min.apply(null, vals), rg = mx - mn || 1;
    var pts = vals.map(function (v, i) { return [(i / Math.max(1, vals.length - 1)) * (s.w - 4) + 2, s.h - 3 - ((v - mn) / rg) * (s.h - 6)]; });
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    var color = opts.color || cssVar('--rac-accent', DEFAULT_PALETTE[0]);
    el.innerHTML = '<svg class="rac-svg" viewBox="0 0 ' + s.w + ' ' + s.h + '" width="100%" height="' + s.h + '" preserveAspectRatio="none">' +
      '<path d="' + line + ' L' + (s.w - 2) + ' ' + s.h + ' L2 ' + s.h + ' Z" fill="' + color + '" opacity="0.12"/>' +
      '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>';
  };

  function categoryBars(el, d, opts, horizontal) {
    opts = opts || {};
    if (stateBox(el, d)) return;
    var dim = dims(d)[0], ms = measures(d);
    if (!dim || !ms.length) { el.innerHTML = '<div class="rac-state">Dữ liệu này không có chiều phân tích</div>'; return; }
    var rows = d.rows.slice(0, opts.top || (horizontal ? 12 : 24));
    var pal = palette(), act = activeValues(d);
    var s = size(el, opts.height);
    var max = 0; rows.forEach(function (r) { ms.forEach(function (m) { var n = num(r[m.key]); if (n !== null && n > max) max = n; }); });
    max = niceMax(max);
    var out = [];
    if (horizontal) {
      var lw = Math.min(180, Math.max(70, s.w * 0.32)), rowH = Math.max(18, Math.min(34, (s.h - 8) / rows.length)), H = rowH * rows.length + 8;
      rows.forEach(function (r, i) {
        var y = 4 + i * rowH, v = num(r[ms[0].key]) || 0, bw = Math.max(1, (v / max) * (s.w - lw - 70));
        var key = String(r[dim.key]), on = !act || act.indexOf(key) >= 0;
        out.push('<g data-rac-v="' + esc(key) + '" data-rac-i="' + i + '" opacity="' + (on ? 1 : 0.3) + '">' +
          '<text x="' + (lw - 8) + '" y="' + (y + rowH / 2 + 4) + '" text-anchor="end" class="rac-axis">' + esc(trunc(label(r[dim.key], dim), 26)) + '</text>' +
          '<rect x="' + lw + '" y="' + (y + rowH * 0.18) + '" width="' + bw.toFixed(1) + '" height="' + (rowH * 0.64).toFixed(1) + '" rx="3" fill="' + (opts.color || cssVar('--rac-accent', pal[0])) + '"/>' +
          '<text x="' + (lw + bw + 6) + '" y="' + (y + rowH / 2 + 4) + '" class="rac-val">' + esc(fmt(v, ms[0], opts)) + '</text></g>');
      });
      el.innerHTML = '<svg class="rac-svg" viewBox="0 0 ' + s.w + ' ' + H + '" width="100%" height="' + H + '">' + out.join('') + '</svg>';
    } else {
      var padL = 44, padB = 34, padT = 10, W = s.w, Hh = s.h, iw = W - padL - 8, ih = Hh - padB - padT;
      for (var t = 0; t <= 4; t++) {
        var yv = padT + ih - (t / 4) * ih;
        out.push('<line x1="' + padL + '" x2="' + (W - 8) + '" y1="' + yv + '" y2="' + yv + '" class="rac-grid"/>' +
          '<text x="' + (padL - 6) + '" y="' + (yv + 4) + '" text-anchor="end" class="rac-axis">' + esc(fmt(max * t / 4, ms[0], { compact: true })) + '</text>');
      }
      var bandW = iw / rows.length, gw = bandW * 0.72, bw2 = gw / ms.length;
      var every = Math.max(1, Math.ceil(rows.length / Math.max(1, Math.floor(iw / 64))));
      rows.forEach(function (r, i) {
        var key = String(r[dim.key]), on = !act || act.indexOf(key) >= 0;
        var g = ['<g data-rac-v="' + esc(key) + '" data-rac-i="' + i + '" opacity="' + (on ? 1 : 0.3) + '">'];
        ms.forEach(function (m, j) {
          var v = num(r[m.key]) || 0, h = Math.max(0, (v / max) * ih);
          g.push('<rect x="' + (padL + i * bandW + (bandW - gw) / 2 + j * bw2).toFixed(1) + '" y="' + (padT + ih - h).toFixed(1) + '" width="' + Math.max(1, bw2 - 2).toFixed(1) + '" height="' + h.toFixed(1) + '" rx="3" fill="' + (j === 0 ? (opts.color || cssVar('--rac-accent', pal[0])) : pal[j % 8]) + '"/>');
        });
        if (i % every === 0) g.push('<text x="' + (padL + i * bandW + bandW / 2).toFixed(1) + '" y="' + (Hh - padB + 16) + '" text-anchor="middle" class="rac-axis">' + esc(trunc(label(r[dim.key], dim), 12)) + '</text>');
        g.push('</g>');
        out.push(g.join(''));
      });
      el.innerHTML = '<svg class="rac-svg" viewBox="0 0 ' + W + ' ' + Hh + '" width="100%" height="' + Hh + '">' + out.join('') + '</svg>';
    }
    hoverRows(el, d, dim, ms);
    bindDrill(el, d);
    cutBadge(el, d);
  }
  function hoverRows(el, d, dim, ms) {
    var pal = palette();
    var marks = el.querySelectorAll('[data-rac-i]');
    for (var i = 0; i < marks.length; i++) {
      marks[i].addEventListener('mousemove', function (e) {
        var r = d.rows[parseInt(this.getAttribute('data-rac-i'), 10)];
        showTip(e, tipHtml(label(r[dim.key], dim), ms.map(function (m, j) { return { label: m.label, value: fmt(r[m.key], m, { compact: false }), color: pal[j % 8] }; })));
      });
      marks[i].addEventListener('mouseleave', hideTip);
    }
  }
  viz.bar = function (el, d, opts) { categoryBars(el, d, opts, false); };
  viz.column = viz.bar;
  viz.hbar = function (el, d, opts) { categoryBars(el, d, opts, true); };

  function series(el, d, opts, area) {
    opts = opts || {};
    if (stateBox(el, d)) return;
    var dim = dims(d)[0], ms = measures(d);
    if (!dim || !ms.length) { el.innerHTML = '<div class="rac-state">Dữ liệu này không có trục thời gian</div>'; return; }
    var rows = d.rows, pal = palette(), s = size(el, opts.height);
    var padL = 48, padB = 30, padT = 12, W = s.w, H = s.h, iw = W - padL - 12, ih = H - padB - padT;
    var max = 0, min = 0;
    rows.forEach(function (r) { ms.forEach(function (m) { var n = num(r[m.key]); if (n !== null) { if (n > max) max = n; if (n < min) min = n; } }); });
    max = niceMax(max);
    var x = function (i) { return padL + (rows.length === 1 ? iw / 2 : (i / (rows.length - 1)) * iw); };
    var y = function (v) { return padT + ih - ((v - min) / ((max - min) || 1)) * ih; };
    var out = [];
    for (var t = 0; t <= 4; t++) {
      var vv = min + (max - min) * t / 4, yy = y(vv);
      out.push('<line x1="' + padL + '" x2="' + (W - 12) + '" y1="' + yy + '" y2="' + yy + '" class="rac-grid"/><text x="' + (padL - 6) + '" y="' + (yy + 4) + '" text-anchor="end" class="rac-axis">' + esc(fmt(vv, ms[0], { compact: true })) + '</text>');
    }
    var every = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor(iw / 70))));
    rows.forEach(function (r, i) { if (i % every === 0 || i === rows.length - 1) out.push('<text x="' + x(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" class="rac-axis">' + esc(trunc(label(r[dim.key], dim), 10)) + '</text>'); });
    var partial = d.partial || [];
    ms.forEach(function (m, j) {
      var c = j === 0 ? (opts.color || cssVar('--rac-accent', pal[0])) : pal[j % 8];
      var pts = rows.map(function (r, i) { return [x(i), y(num(r[m.key]) || 0)]; });
      var path = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
      if (area || opts.area) out.push('<path d="' + path + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + (padT + ih) + ' L' + pts[0][0].toFixed(1) + ' ' + (padT + ih) + ' Z" fill="' + c + '" opacity="0.14"/>');
      out.push('<path d="' + path + '" fill="none" stroke="' + c + '" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>');
      if (rows.length <= 40) pts.forEach(function (p, i) {
        var dashed = partial.indexOf(String(rows[i][dim.key])) >= 0;
        out.push('<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="' + (dashed ? 3.5 : 2.6) + '" fill="' + (dashed ? '#fff' : c) + '" stroke="' + c + '" stroke-width="1.5"/>');
      });
    });
    out.push('<line class="rac-guide" x1="0" x2="0" y1="' + padT + '" y2="' + (padT + ih) + '" style="display:none"/><rect class="rac-hit" x="' + padL + '" y="' + padT + '" width="' + iw + '" height="' + ih + '" fill="transparent"/>');
    el.innerHTML = '<svg class="rac-svg" viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '">' + out.join('') + '</svg>';
    var svg = el.querySelector('svg'), hit = el.querySelector('.rac-hit'), guide = el.querySelector('.rac-guide');
    hit.addEventListener('mousemove', function (e) {
      var b = svg.getBoundingClientRect(), px = (e.clientX - b.left) * (W / b.width);
      var i = Math.max(0, Math.min(rows.length - 1, Math.round(((px - padL) / iw) * (rows.length - 1))));
      guide.setAttribute('x1', x(i)); guide.setAttribute('x2', x(i)); guide.style.display = '';
      var r = rows[i];
      showTip(e, tipHtml(label(r[dim.key], dim) + (partial.indexOf(String(r[dim.key])) >= 0 ? ' (chưa trọn kỳ)' : ''), ms.map(function (m, j) { return { label: m.label, value: fmt(r[m.key], m, { compact: false }), color: pal[j % 8] }; })));
    });
    hit.addEventListener('mouseleave', function () { guide.style.display = 'none'; hideTip(); });
  }
  viz.line = function (el, d, opts) { series(el, d, opts, false); };
  viz.area = function (el, d, opts) { series(el, d, opts, true); };

  viz.donut = function (el, d, opts) {
    opts = opts || {};
    if (stateBox(el, d)) return;
    var dim = dims(d)[0], m = measures(d)[0];
    if (!dim || !m) { el.innerHTML = '<div class="rac-state">Dữ liệu này không có chiều phân tích</div>'; return; }
    var top = opts.top || 6, rows = d.rows.slice(0, top).map(function (r) { return { k: String(r[dim.key]), l: label(r[dim.key], dim), v: Math.max(0, num(r[m.key]) || 0) }; });
    if (additive(m) && d.rows.length > top) {
      var rest = 0; d.rows.slice(top).forEach(function (r) { rest += Math.max(0, num(r[m.key]) || 0); });
      if (rest > 0) rows.push({ k: null, l: 'Khác', v: rest });
    }
    var total = rows.reduce(function (a, r) { return a + r.v; }, 0) || 1, pal = palette(), act = activeValues(d);
    var s = size(el, opts.height || 220), R = Math.min(s.h, 220) / 2 - 6, r0 = R * 0.62, cx = R + 6, cy = R + 6, a = -Math.PI / 2, arcs = [];
    rows.forEach(function (r, i) {
      var a2 = a + (r.v / total) * Math.PI * 2, large = a2 - a > Math.PI ? 1 : 0;
      var p = function (rad, ang) { return (cx + rad * Math.cos(ang)).toFixed(2) + ' ' + (cy + rad * Math.sin(ang)).toFixed(2); };
      var on = !act || (r.k !== null && act.indexOf(r.k) >= 0);
      arcs.push('<path ' + (r.k !== null ? 'data-rac-v="' + esc(r.k) + '" ' : '') + 'data-rac-di="' + i + '" opacity="' + (on ? 1 : 0.3) + '" d="M' + p(R, a) + ' A' + R + ' ' + R + ' 0 ' + large + ' 1 ' + p(R, a2 - 0.0001) + ' L' + p(r0, a2 - 0.0001) + ' A' + r0 + ' ' + r0 + ' 0 ' + large + ' 0 ' + p(r0, a) + ' Z" fill="' + (r.k === null ? '#cbd5e1' : pal[i % 8]) + '"/>');
      a = a2;
    });
    // no centre total: a sum of the shown rows is not the BI Core's total (Top-N, cut rows)
    var center = '';
    var legend = rows.map(function (r, i) {
      return '<div class="rac-leg"><span class="rac-tip-dot" style="background:' + (r.k === null ? '#cbd5e1' : pal[i % 8]) + '"></span><span class="rac-leg-l">' + esc(trunc(r.l, 28)) + '</span><b>' + esc((r.v / total * 100).toFixed(1)) + '%</b></div>';
    }).join('');
    el.innerHTML = '<div class="rac-donut" title="' + esc(provTitle(d, m)) + '"><svg class="rac-svg" viewBox="0 0 ' + (2 * R + 12) + ' ' + (2 * R + 12) + '" width="' + (2 * R + 12) + '" height="' + (2 * R + 12) + '">' + arcs.join('') + center + '</svg><div class="rac-legend">' + legend + '</div></div>';
    var ps = el.querySelectorAll('[data-rac-di]');
    for (var i = 0; i < ps.length; i++) {
      ps[i].addEventListener('mousemove', function (e) { var r = rows[parseInt(this.getAttribute('data-rac-di'), 10)]; showTip(e, tipHtml(r.l, [{ label: m.label, value: fmt(r.v, m, { compact: false }) + ' · ' + (r.v / total * 100).toFixed(1) + '%' }])); });
      ps[i].addEventListener('mouseleave', hideTip);
    }
    bindDrill(el, d);
    cutBadge(el, d);
  };
  viz.pie = viz.donut;

  viz.table = function (el, d, opts) {
    opts = opts || {};
    if (stateBox(el, d)) return;
    var fs = d.fields || [], ms = measures(d), dim = dims(d)[0];
    var sortKey = el.__racSort || null, dir = el.__racDir || -1;
    var rows = d.rows.slice();
    if (sortKey) rows.sort(function (a, b) {
      var x = a[sortKey], y = b[sortKey], nx = num(x), ny = num(y);
      if (nx !== null && ny !== null) return (nx - ny) * dir;
      return String(x).localeCompare(String(y)) * dir;
    });
    var limit = opts.limit || 50, shown = rows.slice(0, el.__racAll ? rows.length : limit);
    var maxes = {}; ms.forEach(function (m) { maxes[m.key] = Math.max.apply(null, rows.map(function (r) { return num(r[m.key]) || 0; }).concat([0])) || 1; });
    var head = fs.map(function (f) { return '<th data-k="' + esc(f.key) + '" class="' + (f.role === 'measure' ? 'num' : '') + '">' + esc(f.label) + (sortKey === f.key ? (dir > 0 ? ' ▲' : ' ▼') : '') + '</th>'; }).join('');
    var body = shown.map(function (r) {
      return '<tr' + (dim && dim.filterKey ? ' data-rac-v="' + esc(String(r[dim.key])) + '"' : '') + '>' + fs.map(function (f) {
        if (f.role !== 'measure') return '<td>' + esc(label(r[f.key], f)) + '</td>';
        var bar = opts.bars !== false ? '<span class="rac-cellbar" style="width:' + Math.max(0, Math.min(100, (num(r[f.key]) || 0) / maxes[f.key] * 100)).toFixed(1) + '%"></span>' : '';
        return '<td class="num">' + bar + '<span>' + esc(fmt(r[f.key], f, { compact: false })) + '</span></td>';
      }).join('') + '</tr>';
    }).join('');
    var more = rows.length > limit && !el.__racAll ? '<button type="button" class="rac-more">Xem tất cả ' + rows.length + ' dòng</button>' : '';
    el.innerHTML = '<div class="rac-table-wrap" title="' + esc(provTitle(d, ms[0])) + '"><table class="rac-table"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>' + more + (d.truncated ? '<div class="rac-note">Hiển thị ' + d.rows.length + ' dòng đầu</div>' : '');
    var ths = el.querySelectorAll('th');
    for (var i = 0; i < ths.length; i++) ths[i].addEventListener('click', function () { var k = this.getAttribute('data-k'); el.__racDir = el.__racSort === k ? -(el.__racDir || -1) : -1; el.__racSort = k; viz.table(el, d, opts); });
    var mb = el.querySelector('.rac-more'); if (mb) mb.addEventListener('click', function () { el.__racAll = true; viz.table(el, d, opts); });
    bindDrill(el, d);
    cutBadge(el, d);
  };

  viz.heatmap = function (el, d, opts) {
    opts = opts || {};
    if (stateBox(el, d)) return;
    var ds = dims(d), m = measures(d)[0];
    if (!ds.length || !m) { el.innerHTML = '<div class="rac-state">Heatmap cần một chiều và một chỉ số</div>'; return; }
    var rowsK = [], colsK = [], cell = {}, rowL = {}, colL = {};
    d.rows.forEach(function (r) {
      var rk, ck;
      if (ds.length >= 2) { rk = String(r[ds[0].key]); ck = String(r[ds[1].key]); rowL[rk] = label(r[ds[0].key], ds[0]); colL[ck] = label(r[ds[1].key], ds[1]); }
      else if (ds[0].kind === 'date') { var s = String(r[ds[0].key]); rk = s.slice(0, 4); ck = s.slice(5, 7); rowL[rk] = rk; colL[ck] = 'T' + parseInt(ck, 10); }
      else { rk = String(r[ds[0].key]); ck = m.key; rowL[rk] = label(r[ds[0].key], ds[0]); colL[ck] = m.label; }
      if (rowsK.indexOf(rk) < 0) rowsK.push(rk);
      if (colsK.indexOf(ck) < 0) colsK.push(ck);
      cell[rk + '|' + ck] = num(r[m.key]);
    });
    colsK.sort(); if (ds[0].kind === 'date') rowsK.sort();
    var vals = Object.keys(cell).map(function (k) { return cell[k]; }).filter(function (v) { return v !== null; });
    var mx = Math.max.apply(null, vals.concat([0])) || 1, mn = Math.min.apply(null, vals.concat([mx]));
    var accent = opts.color || cssVar('--rac-accent', DEFAULT_PALETTE[0]);
    var html = '<div class="rac-heat" title="' + esc(provTitle(d, m)) + '" style="grid-template-columns:minmax(56px,auto) repeat(' + colsK.length + ',minmax(22px,1fr))"><div></div>' +
      colsK.map(function (c) { return '<div class="rac-heat-h">' + esc(colL[c]) + '</div>'; }).join('');
    rowsK.forEach(function (rk) {
      html += '<div class="rac-heat-r">' + esc(trunc(rowL[rk], 18)) + '</div>';
      colsK.forEach(function (ck) {
        var v = cell[rk + '|' + ck], t = v === null || v === undefined ? 0 : (v - mn) / ((mx - mn) || 1);
        html += '<div class="rac-heat-c" data-t="' + esc(rowL[rk] + ' · ' + colL[ck]) + '" data-val="' + esc(v === undefined || v === null ? '—' : fmt(v, m, { compact: false })) + '" style="background:' + (v === undefined || v === null ? 'var(--rac-grid)' : accent) + ';opacity:' + (v === undefined || v === null ? 1 : (0.12 + 0.88 * t).toFixed(3)) + '"></div>';
      });
    });
    el.innerHTML = html + '</div>';
    var cs = el.querySelectorAll('.rac-heat-c');
    for (var i = 0; i < cs.length; i++) {
      cs[i].addEventListener('mousemove', function (e) { showTip(e, tipHtml(this.getAttribute('data-t'), [{ label: m.label, value: this.getAttribute('data-val') }])); });
      cs[i].addEventListener('mouseleave', hideTip);
    }
  };

  viz.gauge = function (el, d, opts) {
    opts = opts || {};
    if (stateBox(el, d)) return;
    var p = primary(d, opts), v = num(p.value) || 0, m = p.field;
    if (p.needsKpi) { needsKpi(el, d, m); el.innerHTML = '<div class="rac-state">—</div>'; return; }
    var target = num(opts.target), max = num(opts.max) || (target ? target * 1.25 : niceMax(v * 1.2));
    var isPct = m && m.format && m.format.kind === 'percent';
    var scaleOnly = target === null && isPct && (num(opts.max) === 100 || num(opts.max) === 1);
    if ((target !== null || num(opts.max) !== null) && !scaleOnly && ctx.mode === 'studio' && !el.__racTargetNoted) {
      el.__racTargetNoted = true;
      report('provenance', 'Gauge "' + ((m && m.label) || '') + '" dùng mục tiêu/giới hạn do mã báo cáo tự đặt (' + (target !== null ? target : opts.max) +
        '), không đến từ dữ liệu — hãy xác nhận đây là mục tiêu thật.');
    }
    var frac = Math.max(0, Math.min(1, v / (max || 1)));
    var W = 220, H = 128, cx = 110, cy = 112, R = 92, w = 16;
    var arc = function (f) { var a = Math.PI * (1 - f); return (cx + R * Math.cos(a)).toFixed(2) + ' ' + (cy - R * Math.sin(a)).toFixed(2); };
    var color = opts.color || (target ? (v >= target ? cssVar('--rac-pos', '#059669') : cssVar('--rac-warn', '#f59e0b')) : cssVar('--rac-accent', DEFAULT_PALETTE[0]));
    var tmark = target ? (function () { var a = Math.PI * (1 - Math.min(1, target / max)); return '<line x1="' + (cx + (R - w) * Math.cos(a)).toFixed(1) + '" y1="' + (cy - (R - w) * Math.sin(a)).toFixed(1) + '" x2="' + (cx + (R + 8) * Math.cos(a)).toFixed(1) + '" y2="' + (cy - (R + 8) * Math.sin(a)).toFixed(1) + '" stroke="var(--rac-text)" stroke-width="2"/>'; })() : '';
    el.innerHTML = '<div class="rac-gauge" title="' + esc(provTitle(d, m)) + '"><svg class="rac-svg" viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:280px">' +
      '<path d="M' + arc(0) + ' A' + R + ' ' + R + ' 0 0 1 ' + arc(1) + '" fill="none" stroke="var(--rac-grid)" stroke-width="' + w + '" stroke-linecap="round"/>' +
      '<path d="M' + arc(0) + ' A' + R + ' ' + R + ' 0 0 1 ' + arc(Math.max(0.001, frac)) + '" fill="none" stroke="' + color + '" stroke-width="' + w + '" stroke-linecap="round"/>' + tmark +
      '<text x="' + cx + '" y="' + (cy - 18) + '" text-anchor="middle" class="rac-gauge-v">' + esc(fmt(v, m, opts)) + '</text>' +
      '<text x="' + cx + '" y="' + (cy + 2) + '" text-anchor="middle" class="rac-axis">' + esc(target ? 'Mục tiêu ' + fmt(target, m, opts) : (opts.label || (m && m.label) || '')) + '</text></svg></div>';
  };

  viz.waterfall = function (el, d, opts) {
    opts = opts || {};
    if (stateBox(el, d)) return;
    var dim = dims(d)[0], m = measures(d)[0];
    if (!dim || !m) { el.innerHTML = '<div class="rac-state">Waterfall cần một chiều và một chỉ số</div>'; return; }
    var steps = [], rows = d.rows.slice(0, opts.top || 14);
    if (dim.kind === 'date') {
      rows.forEach(function (r, i) {
        var v = num(r[m.key]) || 0;
        if (i === 0) steps.push({ l: label(r[dim.key], dim), base: 0, v: v, kind: 'total' });
        else steps.push({ l: label(r[dim.key], dim), base: num(rows[i - 1][m.key]) || 0, v: v - (num(rows[i - 1][m.key]) || 0), kind: 'delta' });
      });
    } else {
      var acc = 0;
      rows.forEach(function (r) { var v = num(r[m.key]) || 0; steps.push({ l: label(r[dim.key], dim), base: acc, v: v, kind: 'delta', k: String(r[dim.key]) }); acc += v; });
      steps.push({ l: 'Tổng', base: 0, v: acc, kind: 'total' });
    }
    var s = size(el, opts.height), padL = 48, padB = 34, padT = 10, iw = s.w - padL - 8, ih = s.h - padB - padT;
    var top = 0, low = 0; steps.forEach(function (st) { top = Math.max(top, st.base, st.base + st.v); low = Math.min(low, st.base, st.base + st.v); });
    top = niceMax(top);
    var y = function (v) { return padT + ih - ((v - low) / ((top - low) || 1)) * ih; };
    var bw = iw / steps.length, out = [];
    for (var t = 0; t <= 4; t++) { var vv = low + (top - low) * t / 4; out.push('<line x1="' + padL + '" x2="' + (s.w - 8) + '" y1="' + y(vv) + '" y2="' + y(vv) + '" class="rac-grid"/><text x="' + (padL - 6) + '" y="' + (y(vv) + 4) + '" text-anchor="end" class="rac-axis">' + esc(fmt(vv, m, { compact: true })) + '</text>'); }
    var every = Math.max(1, Math.ceil(steps.length / Math.max(1, Math.floor(iw / 56))));
    steps.forEach(function (st, i) {
      var y1 = y(st.base), y2 = y(st.base + st.v), c = st.kind === 'total' ? cssVar('--rac-accent', DEFAULT_PALETTE[0]) : (st.v >= 0 ? cssVar('--rac-pos', '#059669') : cssVar('--rac-neg', '#dc2626'));
      out.push('<g data-rac-wi="' + i + '"' + (st.k ? ' data-rac-v="' + esc(st.k) + '"' : '') + '><rect x="' + (padL + i * bw + bw * 0.15).toFixed(1) + '" y="' + Math.min(y1, y2).toFixed(1) + '" width="' + (bw * 0.7).toFixed(1) + '" height="' + Math.max(1, Math.abs(y2 - y1)).toFixed(1) + '" rx="2" fill="' + c + '"/>' +
        (i % every === 0 ? '<text x="' + (padL + i * bw + bw / 2).toFixed(1) + '" y="' + (s.h - padB + 16) + '" text-anchor="middle" class="rac-axis">' + esc(trunc(st.l, 10)) + '</text>' : '') + '</g>');
    });
    el.innerHTML = '<svg class="rac-svg" viewBox="0 0 ' + s.w + ' ' + s.h + '" width="100%" height="' + s.h + '">' + out.join('') + '</svg>';
    var gs = el.querySelectorAll('[data-rac-wi]');
    for (var i = 0; i < gs.length; i++) {
      gs[i].addEventListener('mousemove', function (e) { var st = steps[parseInt(this.getAttribute('data-rac-wi'), 10)]; showTip(e, tipHtml(st.l, [{ label: st.kind === 'total' ? m.label : 'Thay đổi', value: (st.kind === 'delta' && st.v > 0 ? '+' : '') + fmt(st.v, m, { compact: false }) }])); });
      gs[i].addEventListener('mouseleave', hideTip);
    }
    bindDrill(el, d);
    cutBadge(el, d);
  };

  viz.progress = function (el, d, opts) {
    opts = opts || {};
    if (stateBox(el, d)) return;
    var dim = dims(d)[0], m = measures(d)[0];
    if (!dim || !m) { viz.kpi(el, d, opts); return; }
    var rows = d.rows.slice(0, opts.top || 8), mx = Math.max.apply(null, rows.map(function (r) { return num(r[m.key]) || 0; }).concat([0])) || 1, act = activeValues(d);
    el.innerHTML = '<div class="rac-progress">' + rows.map(function (r) {
      var v = num(r[m.key]) || 0, key = String(r[dim.key]), on = !act || act.indexOf(key) >= 0;
      return '<div class="rac-prog-row" data-rac-v="' + esc(key) + '" style="opacity:' + (on ? 1 : 0.35) + '"><div class="rac-prog-top"><span>' + esc(trunc(label(r[dim.key], dim), 32)) + '</span><b>' + esc(fmt(v, m)) + '</b></div><div class="rac-prog-track"><div class="rac-prog-fill" style="width:' + (v / mx * 100).toFixed(1) + '%"></div></div></div>';
    }).join('') + '</div>';
    bindDrill(el, d);
    cutBadge(el, d);
  };

  // ── 6. Filters ─────────────────────────────────────────────────────────────────
  // The filter values the numbers on screen were computed with (from the DTOs): the
  // viewer's choice, a lock, or the report's default period. Text bound to a filter reads
  // THIS, so a headline can never name a period the numbers do not cover.
  var applied = {};
  function effState(key) { var v = ctx.state && ctx.state[key]; return v !== undefined && v !== null && (!Array.isArray(v) || v.length) ? v : applied[key]; }
  function monthLabel(iso) { var s = String(iso || ''); return s.length >= 7 ? 'Tháng ' + s.slice(5, 7) + '/' + s.slice(0, 4) : s; }
  function stateText(key, o) {
    var decl = filterDecl(key), v = effState(key);
    if (v === undefined || v === null || (Array.isArray(v) && !v.length)) return o.empty !== undefined ? String(o.empty) : 'Tất cả';
    if (decl && decl.kind === 'date') {
      if (decl.grain === 'month') return monthLabel(v[0]);
      var d = function (x) { return x ? fmtDate(x) : '…'; };
      return d(v[0]) + ' – ' + d(v[1]);
    }
    return Array.isArray(v) ? v.join(', ') : String(v);
  }
  function renderFilterBound() {
    var ts = document.querySelectorAll('[data-rac-filter-text]');
    for (var i = 0; i < ts.length; i++) {
      var o = opts(ts[i]);
      ts[i].textContent = (o.prefix || '') + stateText(ts[i].getAttribute('data-rac-filter-text'), o) + (o.suffix || '');
      ts[i].setAttribute('data-rac-prov', 'filter');
    }
    var fs = document.querySelectorAll('[data-rac-filter]');
    for (var j = 0; j < fs.length; j++) { var dk = filterDecl(fs[j].getAttribute('data-rac-filter')); if (dk && (dk.grain === 'month' || dk.single)) mountFilter(fs[j]); }
  }
  function cellField(d, ref) {
    if (!ref || ref === 'dim' || ref === 'd') return dims(d)[0] || null;
    if (ref === 'm') return measures(d)[0] || null;
    return field(d, ref);
  }
  function tone(v, bands) {
    if (v === null || v === undefined || !Array.isArray(bands)) return '';
    for (var i = 0; i < bands.length; i++) { var b = bands[i]; if (!Array.isArray(b)) continue; if (b[0] === null || Number(v) < Number(b[0])) return String(b[1]); }
    return '';
  }
  // A repeated structure in free HTML: the authored element is the TEMPLATE, cloned once
  // per result row; every clone is rebuilt from the BI Core rows on each result.
  function renderRepeat(tpl) {
    var id = tpl.getAttribute('data-rac-repeat'), d = cache[id], o = opts(tpl);
    if (!tpl.__racTpl) { tpl.__racTpl = tpl.cloneNode(true); tpl.__racTpl.removeAttribute('data-rac-repeat'); }
    var parent = tpl.parentNode; if (!parent) return;
    var old = parent.querySelectorAll('[data-rac-clone="' + cssEsc(id) + '"]');
    for (var i = 0; i < old.length; i++) if (old[i].parentNode === parent) parent.removeChild(old[i]);
    tpl.style.display = 'none';
    tpl.setAttribute('aria-hidden', 'true');
    if (unbound(id, d)) {
      var note = document.createElement(tpl.tagName === 'TR' ? 'tr' : 'div');
      note.setAttribute('data-rac-clone', id);
      note.innerHTML = tpl.tagName === 'TR' ? '<td colspan="99">' + UNBOUND_HTML + '</td>' : UNBOUND_HTML;
      parent.insertBefore(note, tpl.nextSibling);
      return;
    }
    if (!d || d.status === 'loading') { tpl.style.display = ''; return; }
    var rows = (d.rows || []).slice();
    if (o.sort) {
      var desc = o.sort.charAt(0) === '-', sf = cellField(d, desc ? o.sort.slice(1) : o.sort);
      if (sf) rows.sort(function (a, b) { var x = a[sf.key], y = b[sf.key]; return (x === y ? 0 : x > y ? 1 : -1) * (desc ? -1 : 1); });
    }
    if (o.limit) rows = rows.slice(0, parseInt(o.limit, 10));
    var after = tpl;
    if (!rows.length) {
      var none = tpl.__racTpl.cloneNode(false);
      none.setAttribute('data-rac-clone', id);
      var msg = '<span class="rac-note">' + esc(d.error || o.empty || 'Không có dữ liệu cho bộ lọc đang chọn') + '</span>';
      none.innerHTML = none.tagName === 'TR' ? '<td colspan="99">' + msg + '</td>' : msg;
      parent.insertBefore(none, after.nextSibling);
      return;
    }
    var maxOf = {}, gen = (tpl.__racGen = (tpl.__racGen || 0) + 1);
    function drawRow(row, idx) {
      var el = tpl.__racTpl.cloneNode(true);
      el.setAttribute('data-rac-clone', id);
      el.setAttribute('data-rac-prov', d.bindingId || id);
      var cells = el.querySelectorAll('[data-rac-cell]');
      for (var c = 0; c < cells.length; c++) {
        var f = cellField(d, cells[c].getAttribute('data-rac-cell'));
        if (!f) { cells[c].textContent = '—'; continue; }
        if (cells[c].getAttribute('data-rac-cell') === '#') { cells[c].textContent = String(idx + 1); continue; }
        cells[c].textContent = f.role === 'measure' ? fmt(row[f.key], f, opts(cells[c])) : label(row[f.key], f);
        cells[c].title = provTitle(d, f.role === 'measure' ? f : measures(d)[0]);
        cells[c].setAttribute('data-rac-prov', d.bindingId || id);
      }
      var bars = el.querySelectorAll('[data-rac-bar]');
      for (var b = 0; b < bars.length; b++) {
        var bf = cellField(d, bars[b].getAttribute('data-rac-bar'));
        if (!bf) continue;
        if (maxOf[bf.key] === undefined) maxOf[bf.key] = Math.max.apply(null, rows.map(function (r) { return Math.abs(Number(r[bf.key]) || 0); }).concat([0]));
        var mx = maxOf[bf.key] || 1;
        bars[b].style.width = Math.max(0, Math.min(100, (Math.abs(Number(row[bf.key]) || 0) / mx) * 100)).toFixed(1) + '%';
      }
      var tones = el.querySelectorAll('[data-rac-tone]');
      if (el.hasAttribute('data-rac-tone')) tones = [el].concat(Array.prototype.slice.call(tones));
      for (var t = 0; t < tones.length; t++) {
        var tf = cellField(d, tones[t].getAttribute('data-rac-tone'));
        if (tf) tones[t].setAttribute('data-rac-tone-v', tone(row[tf.key], opts(tones[t]).bands || o.bands));
      }
      return el;
    }
    function drawRange(from, to) {
      var frag = document.createDocumentFragment();
      for (var k = from; k < to; k++) frag.appendChild(drawRow(rows[k], k));
      var last = frag.lastChild;
      parent.insertBefore(frag, after.nextSibling);
      if (last) after = last;
    }
    var FIRST = 100, CHUNK = 200;
    drawRange(0, Math.min(FIRST, rows.length));
    var at = Math.min(FIRST, rows.length);
    var later = window.requestIdleCallback || function (fn) { return setTimeout(fn, 16); };
    function more() {
      if (tpl.__racGen !== gen || at >= rows.length) { if (at >= rows.length && tpl.__racGen === gen) tail(); return; }
      drawRange(at, Math.min(at + CHUNK, rows.length)); at = Math.min(at + CHUNK, rows.length);
      if (at < rows.length) later(more); else tail();
    }
    if (at < rows.length) { later(more); return; }
    tail();
    function tail() {
    var cut = cutNote(d);
    if (cut && o.cutNote !== false) {
      // the list is not the whole population: say so after the rows (same element type)
      var note = tpl.__racTpl.cloneNode(false);
      note.removeAttribute('data-rac-tone'); note.setAttribute('data-rac-clone', id); note.setAttribute('data-rac-prov', 'cut');
      note.innerHTML = note.tagName === 'TR' ? '<td colspan="99"><span class="rac-note">' + esc(cut) + '</span></td>' : '<span class="rac-note">' + esc(cut) + '</span>';
      parent.insertBefore(note, after.nextSibling);
    }
    }
  }
  function renderSamples() {
    var ss = document.querySelectorAll('[data-rac-sample]');
    for (var i = 0; i < ss.length; i++) { ss[i].classList.add('rac-sample'); ss[i].title = 'Số mẫu từ thiết kế — chưa nối dữ liệu BI Core'; }
    // ONE legend says what the dashed outline means (a badge on every figure hid the figures)
    var lg = document.querySelector('.rac-sample-legend');
    if (ss.length && !lg) {
      lg = document.createElement('div');
      lg.className = 'rac-sample-legend';
      lg.setAttribute('data-rac-prov', 'legend');
      document.body.appendChild(lg);
    }
    if (lg) { lg.style.display = ss.length ? '' : 'none'; lg.textContent = 'Viền nét đứt = số mẫu của thiết kế, chưa nối dữ liệu BI Core'; }
  }
  function filterDecl(key) { for (var i = 0; i < ctx.filters.length; i++) if (ctx.filters[i].key === key) return ctx.filters[i]; return null; }
  function setFilter(key, value) {
    if (!filterDecl(key)) { report('filter', 'Unknown filter "' + key + '" — use one of rac.filters()'); return; }
    var clean = value === null || value === undefined || (Array.isArray(value) && !value.length) ? null : value;
    send({ type: 'setFilter', key: key, value: clean });
  }
  function values(key, search) {
    return new Promise(function (resolve) {
      var id = 'v' + (++reqSeq);
      pending[id] = resolve;
      send({ type: 'values', reqId: id, key: key, search: search || '' });
      setTimeout(function () { if (pending[id]) { pending[id]([]); delete pending[id]; } }, 15000);
    });
  }
  function mountFilter(el) {
    var key = el.getAttribute('data-rac-filter'), decl = filterDecl(key);
    if (!decl && key === 'missing') {
      // an import could not bind this filter: said to everyone (it is no locked filter)
      el.innerHTML = '<span class="rac-unbound-chip" data-rac-prov="unbound">Bộ lọc chưa gắn dữ liệu</span>';
      return;
    }
    if (!decl) {
      // In the Studio an unknown key is the author's mistake: say so. For a viewer it is
      // a filter this link keeps to itself (locked, hidden or switched off): show nothing.
      if (ctx.mode === 'studio') el.innerHTML = '<span class="rac-note">Bộ lọc "' + esc(key) + '" chưa được khai báo</span>';
      else { el.innerHTML = ''; el.style.display = 'none'; }
      return;
    }
    el.style.display = '';
    var cur = ctx.state[key];
    if (decl.kind === 'date' && decl.grain === 'month') {
      var curM = (effState(key) || [])[0] || '';
      el.innerHTML = '<div class="rac-filter rac-filter-period"><span class="rac-filter-l">' + esc(el.getAttribute('data-rac-label') || decl.label) + '</span>' +
        '<select aria-label="' + esc(decl.label) + '"><option value="">' + esc(curM ? monthLabel(curM) : '…') + '</option></select></div>';
      var pick = el.querySelector('select');
      values(key, '').then(function (vals) {
        var ms = (vals || []).map(String);
        if (!ms.length) return;
        pick.innerHTML = ms.map(function (m) { return '<option value="' + esc(m) + '"' + (m.slice(0, 7) === String(curM).slice(0, 7) ? ' selected' : '') + '>' + esc(monthLabel(m)) + '</option>'; }).join('');
      });
      pick.addEventListener('change', function () { if (this.value) setFilter(key, [this.value, null]); });
      return;
    }
    if (decl.single) {
      // one value at a time (an org picker): a select, its current value = what the numbers used
      var curS = (effState(key) || [])[0];
      el.innerHTML = '<div class="rac-filter rac-filter-period"><span class="rac-filter-l">' + esc(el.getAttribute('data-rac-label') || decl.label) + '</span>' +
        '<select aria-label="' + esc(decl.label) + '"><option value="">' + esc(curS === undefined ? '…' : String(curS)) + '</option></select></div>';
      var one = el.querySelector('select');
      values(key, '').then(function (vals) {
        var vs = (vals || []).map(String);
        if (!vs.length) return;
        one.innerHTML = vs.map(function (v) { return '<option value="' + esc(v) + '"' + (v === String(curS) ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('');
      });
      one.addEventListener('change', function () { if (this.value) setFilter(key, [this.value]); });
      return;
    }
    if (decl.kind === 'date') {
      var from = Array.isArray(cur) ? cur[0] || '' : '', to = Array.isArray(cur) ? cur[1] || '' : '';
      el.innerHTML = '<div class="rac-filter rac-filter-date"><span class="rac-filter-l">' + esc(el.getAttribute('data-rac-label') || decl.label) + '</span>' +
        '<input type="date" value="' + esc(from) + '" data-p="0"><span>→</span><input type="date" value="' + esc(to) + '" data-p="1">' +
        (from || to ? '<button type="button" class="rac-x" title="Xóa">×</button>' : '') + '</div>';
      var ins = el.querySelectorAll('input');
      for (var i = 0; i < ins.length; i++) ins[i].addEventListener('change', function () { var a = ins[0].value, b = ins[1].value; setFilter(key, a || b ? [a || null, b || null] : null); });
      var x = el.querySelector('.rac-x'); if (x) x.addEventListener('click', function () { setFilter(key, null); });
      return;
    }
    var prevPop = el.querySelector('.rac-pop'), prevSearch = el.querySelector('.rac-pop input[type=search]');
    var wasOpen = !!(prevPop && !prevPop.hasAttribute('hidden')), prevQ = prevSearch ? prevSearch.value : '';
    var sel = Array.isArray(cur) ? cur.map(String) : [];
    var text = sel.length === 0 ? 'Tất cả' : sel.length === 1 ? sel[0] : sel.length + ' đã chọn';
    el.innerHTML = '<div class="rac-filter"><button type="button" class="rac-filter-btn"><span class="rac-filter-l">' + esc(el.getAttribute('data-rac-label') || decl.label) + '</span><span class="rac-filter-v">' + esc(trunc(text, 24)) + '</span><span class="rac-caret">▾</span></button>' +
      (sel.length ? '<button type="button" class="rac-x" title="Xóa">×</button>' : '') + '<div class="rac-pop" hidden><input type="search" placeholder="Tìm…"><div class="rac-opts"><div class="rac-note">Đang tải…</div></div></div></div>';
    var btn = el.querySelector('.rac-filter-btn'), pop = el.querySelector('.rac-pop'), search = el.querySelector('input'), list = el.querySelector('.rac-opts');
    var xb = el.querySelector('.rac-x'); if (xb) xb.addEventListener('click', function (e) { e.stopPropagation(); setFilter(key, null); });
    var load = function () {
      values(key, search.value).then(function (vals) {
        if (!vals.length) { list.innerHTML = '<div class="rac-note">Không có giá trị</div>'; return; }
        list.innerHTML = vals.slice(0, 200).map(function (v) { var s = String(v); return '<label class="rac-opt"><input type="checkbox" value="' + esc(s) + '"' + (sel.indexOf(s) >= 0 ? ' checked' : '') + '> <span>' + esc(s) + '</span></label>'; }).join('');
        var cbs = list.querySelectorAll('input');
        for (var i = 0; i < cbs.length; i++) cbs[i].addEventListener('change', function () {
          var s = this.value, i2 = sel.indexOf(s);
          if (this.checked && i2 < 0) sel.push(s); else if (!this.checked && i2 >= 0) sel.splice(i2, 1);
          setFilter(key, sel.slice());
        });
      });
    };
    btn.addEventListener('click', function (e) { e.stopPropagation(); var open = pop.hasAttribute('hidden'); closePops(); if (open) { pop.removeAttribute('hidden'); load(); search.focus(); } });
    var t = null; search.addEventListener('input', function () { clearTimeout(t); t = setTimeout(load, 250); });
    pop.addEventListener('click', function (e) { e.stopPropagation(); });
    if (wasOpen) { search.value = prevQ; pop.removeAttribute('hidden'); load(); }
  }
  function closePops() { var ps = document.querySelectorAll('.rac-pop'); for (var i = 0; i < ps.length; i++) ps[i].setAttribute('hidden', ''); }
  document.addEventListener('click', closePops);
  function mountChips(el) {
    var keys = Object.keys(ctx.state || {}).filter(function (k) { var v = ctx.state[k]; return v !== null && v !== undefined && (!Array.isArray(v) || v.length); });
    if (!keys.length) { el.innerHTML = ''; el.style.display = 'none'; return; }
    el.style.display = '';
    el.innerHTML = keys.map(function (k) {
      var decl = filterDecl(k), v = ctx.state[k];
      var txt = decl && decl.kind === 'date' ? (v[0] || '…') + ' → ' + (v[1] || '…') : (Array.isArray(v) ? v.join(', ') : String(v));
      return '<span class="rac-chip">' + esc((decl ? decl.label : k) + ': ' + trunc(txt, 40)) + '<button type="button" data-k="' + esc(k) + '">×</button></span>';
    }).join('') + '<button type="button" class="rac-chip-clear">Xóa bộ lọc</button>';
    var bs = el.querySelectorAll('button[data-k]');
    for (var i = 0; i < bs.length; i++) bs[i].addEventListener('click', function () { setFilter(this.getAttribute('data-k'), null); });
    el.querySelector('.rac-chip-clear').addEventListener('click', function () { send({ type: 'clearFilters' }); });
  }

  // ── 7. Declarative mounting ────────────────────────────────────────────────────
  function opts(el) { var raw = el.getAttribute('data-rac-opts'); if (!raw) return {}; try { return JSON.parse(raw); } catch (e) { report('script', 'Invalid data-rac-opts JSON on ' + el.tagName.toLowerCase()); return {}; } }
  function renderViz(el) {
    var kind = el.getAttribute('data-rac-viz'), id = el.getAttribute('data-rac-bind');
    var fn = viz[kind];
    if (!fn) { el.innerHTML = '<div class="rac-state rac-error">Không có kiểu hiển thị "' + esc(kind) + '"</div>'; return; }
    var d = cache[id];
    if (unbound(id, d)) { el.innerHTML = UNBOUND_HTML; return; }
    try { fn(el, d || { status: 'loading', bindingId: id }, opts(el)); } catch (err) { el.innerHTML = '<div class="rac-state rac-error">' + esc(err.message) + '</div>'; report('render', kind + ': ' + err.message); }
  }
  function renderValue(el) {
    var vid = el.getAttribute('data-rac-value'), d = cache[vid];
    if (unbound(vid, d)) {
      el.innerHTML = '<span class="rac-unbound-chip" data-rac-prov="unbound" title="Vị trí này chưa được nối với dữ liệu BI Core">Chưa gắn dữ liệu</span>';
      return;
    }
    if (!d || d.status !== 'ready') { el.textContent = d && (d.status === 'error' || d.status === 'refused' || d.status === 'empty') ? '—' : '…'; if (d && d.error) el.title = d.error; return; }
    var o = opts(el), fkey = el.getAttribute('data-rac-field') || o.field;
    var rowKey = el.getAttribute('data-rac-row'), rank = el.getAttribute('data-rac-rank');
    if (rowKey !== null || rank !== null) {
      // One cell of one row: a hand-built table addresses rows by dimension value or rank.
      var dim = dims(d)[0], rows = d.rows || [], row = null;
      if (rank !== null) row = rows[parseInt(rank, 10)] || null;
      else if (dim) for (var i = 0; i < rows.length; i++) if (String(rows[i][dim.key]) === rowKey) { row = rows[i]; break; }
      var f = fkey ? field(d, fkey) : measures(d)[0];
      if (!row || !f) { el.textContent = '—'; return; }
      el.textContent = f.role === 'measure' ? fmt(row[f.key], f, o) : label(row[f.key], f);
      el.title = provTitle(d, f.role === 'measure' ? f : measures(d)[0]);
      el.setAttribute('data-rac-prov', d.bindingId || '');
      return;
    }
    var p = primary(d, { field: fkey });
    if (p.needsKpi) { el.textContent = '—'; needsKpi(el, d, p.field); return; }
    el.textContent = fmt(p.value, p.field, o);
    el.title = provTitle(d, p.field);
    el.setAttribute('data-rac-prov', d.bindingId || '');
  }
  // What the page needs NOW: bindings drawn by an element that is rendered (not inside a
  // hidden tab / page / collapsed section) plus every binding the author's JS subscribed to.
  // The host loads only these; a hidden one loads when it is shown. A repeat with its own
  // row cap (data-rac-limit / opts.limit) asks the server for that many rows only.
  var lastNeed = '', needTimer = null;
  function shown(el) {
    if (el.hasAttribute('data-rac-repeat') && el.style.display === 'none') el = el.parentNode || el;
    if (!el || !el.getClientRects) return false;
    // checkVisibility also sees a closed <details> (content-visibility), which keeps its boxes
    return el.checkVisibility ? el.checkVisibility() : !!el.getClientRects().length;
  }
  function needed() {
    var ids = {}, limits = {}, other = {};
    var els = document.querySelectorAll('[data-rac-bind],[data-rac-value],[data-rac-repeat],[data-rac-title],[data-rac-asof]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], id = el.getAttribute('data-rac-bind') || el.getAttribute('data-rac-value') || el.getAttribute('data-rac-repeat')
        || el.getAttribute('data-rac-title') || el.getAttribute('data-rac-asof');
      if (!id || !shown(el)) continue;
      ids[id] = 1;
      if (el.hasAttribute('data-rac-repeat')) {
        var lim = parseInt(el.getAttribute('data-rac-limit') || opts(el).limit || '0', 10);
        if (lim > 0 && !other[id]) limits[id] = Math.max(limits[id] || 0, lim); else { other[id] = 1; delete limits[id]; }
      } else if (!el.hasAttribute('data-rac-title') && !el.hasAttribute('data-rac-asof')) { other[id] = 1; delete limits[id]; }
    }
    Object.keys(subs).forEach(function (id) { ids[id] = 1; other[id] = 1; delete limits[id]; });
    var list = Object.keys(ids).sort();
    return { ids: list, limits: limits, key: list.join(',') + '|' + JSON.stringify(limits) };
  }
  function checkNeed() {
    clearTimeout(needTimer);
    needTimer = setTimeout(function () {
      if (!port) return;
      var nd = needed();
      if (nd.key === lastNeed) return;
      lastNeed = nd.key;
      send({ type: 'need', ids: nd.ids, limits: nd.limits });
    }, 80);
  }
  function watchNeed() {
    try {
      new MutationObserver(checkNeed).observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'], subtree: true, childList: true });
    } catch (e) { /* no observer: everything visible at ready was asked, the rest on hash/resize */ }
    window.addEventListener('hashchange', checkNeed);
    window.addEventListener('resize', checkNeed);
    document.addEventListener('toggle', checkNeed, true);
  }
  function renderBinding(id) {
    var els = document.querySelectorAll('[data-rac-bind="' + cssEsc(id) + '"][data-rac-viz]');
    for (var i = 0; i < els.length; i++) renderViz(els[i]);
    var vs = document.querySelectorAll('[data-rac-value="' + cssEsc(id) + '"]');
    for (var j = 0; j < vs.length; j++) renderValue(vs[j]);
    var rp = document.querySelectorAll('[data-rac-repeat="' + cssEsc(id) + '"]');
    for (var r = 0; r < rp.length; r++) renderRepeat(rp[r]);
    var ts = document.querySelectorAll('[data-rac-title="' + cssEsc(id) + '"]');
    for (var k = 0; k < ts.length; k++) if (cache[id] && cache[id].title) ts[k].textContent = cache[id].title;
    var as = document.querySelectorAll('[data-rac-asof="' + cssEsc(id) + '"]');
    for (var l = 0; l < as.length; l++) { var p = cache[id] && cache[id].provenance; as[l].textContent = p && p.asOf ? String(p.asOf).replace('T', ' ').slice(0, 16) : ''; }
  }
  function renderAll() {
    var vz = document.querySelectorAll('[data-rac-viz]'); for (var i = 0; i < vz.length; i++) renderViz(vz[i]);
    var vs = document.querySelectorAll('[data-rac-value]'); for (var j = 0; j < vs.length; j++) renderValue(vs[j]);
    var fs = document.querySelectorAll('[data-rac-filter]'); for (var k = 0; k < fs.length; k++) mountFilter(fs[k]);
    var cs = document.querySelectorAll('[data-rac-filter-chips]'); for (var l = 0; l < cs.length; l++) mountChips(cs[l]);
    var rp = document.querySelectorAll('[data-rac-repeat]');
    for (var r = 0; r < rp.length; r++) { var rid = rp[r].getAttribute('data-rac-repeat'); if (!cache[rid] || unbound(rid, cache[rid])) renderRepeat(rp[r]); }
    Object.keys(cache).forEach(renderBinding);
    renderFilterBound();
    renderSamples();
  }
  var mountTimer = null;
  function scheduleMount() {
    if (mountTimer) return;
    mountTimer = setTimeout(function () {
      mountTimer = null;
      var fresh = document.querySelectorAll('[data-rac-viz]:not([data-rac-m]),[data-rac-value]:not([data-rac-m]),[data-rac-filter]:not([data-rac-m]),[data-rac-filter-chips]:not([data-rac-m])');
      for (var i = 0; i < fresh.length; i++) {
        var el = fresh[i];
        el.setAttribute('data-rac-m', '1');
        if (el.hasAttribute('data-rac-viz')) renderViz(el);
        else if (el.hasAttribute('data-rac-value')) renderValue(el);
        else if (el.hasAttribute('data-rac-filter')) mountFilter(el);
        else mountChips(el);
      }
      // a repeated row whose binding the report does not have never gets data to draw it:
      // it says "not bound" at once (a bound one waits for its data, as before)
      var reps = document.querySelectorAll('[data-rac-repeat]:not([data-rac-m])');
      for (var r = 0; r < reps.length; r++) {
        var rid = reps[r].getAttribute('data-rac-repeat');
        if (unbound(rid, cache[rid])) { reps[r].setAttribute('data-rac-m', '1'); renderRepeat(reps[r]); }
      }
    }, 30);
  }
  // Studio quality gate: a page wider than its viewport is a responsive defect the
  // author should see at the device width they are previewing.
  var overflowT = null, overflowSeen = {};
  function checkOverflow() {
    clearTimeout(overflowT);
    overflowT = setTimeout(function () {
      if (ctx.mode !== 'studio') return;
      var w = document.documentElement.clientWidth, sw = document.documentElement.scrollWidth;
      if (sw > w + 2 && !overflowSeen[w]) {
        overflowSeen[w] = 1;
        var culprits = [], seen = {};
        var all = document.body.querySelectorAll('*');
        for (var i = 0; i < all.length && culprits.length < 4; i++) {
          var el = all[i], r = el.getBoundingClientRect();
          if (r.right <= w + 2 || r.width <= 0) continue;
          var parent = el.parentElement, pr = parent ? parent.getBoundingClientRect() : null;
          if (pr && pr.right > w + 2 && parent !== document.body) continue; // report the outermost offender only
          var reg = el.closest('[data-rac-region]');
          var name = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
          var key = (reg ? reg.getAttribute('data-rac-region') : '') + name;
          if (seen[key]) continue;
          seen[key] = 1;
          culprits.push((reg ? 'region "' + reg.getAttribute('data-rac-region') + '" ' : '') + name + ' rộng ' + Math.round(r.width) + 'px');
        }
        report('layout', 'Trang tràn ngang ở độ rộng ' + w + 'px (nội dung rộng ' + sw + 'px). Phần tử tràn: ' + (culprits.join('; ') || 'không xác định') + '.');
      }
    }, 1500);
  }
  // Studio provenance audit: every number the report's OWN markup/code shows should be a
  // value of its bound data. Numbers drawn by rac.viz / data-rac-value are trusted (the
  // runtime formats them from the DTO); the rest is checked against every formatted value.
  var auditT = null, auditSeen = {};
  var TRUSTED = '.rac-kpi,.rac-svg,.rac-table-wrap,.rac-heat,.rac-gauge,.rac-progress,.rac-donut,.rac-filter,.rac-chip,.rac-tip,[data-rac-value],[data-rac-asof],'
    + '.rac-note,.rac-state,.rac-unbound-chip,.rac-sample-legend,[data-rac-prov],[data-rac-static],script,style,input,select,textarea,option';
  // a date written in the text (24/08/2026, 2026-08-24) is not a figure: never split into numbers
  var DATE_RX = /\b\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}\b|\b\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}\b/g;
  function auditNumbers() {
    clearTimeout(auditT);
    auditT = setTimeout(function () {
      if (ctx.mode !== 'studio') return;
      var allowed = {};
      var add = function (s) { allowed[String(s).replace(/\s+/g, '')] = 1; };
      Object.keys(cache).forEach(function (id) {
        var d = cache[id];
        (d.rows || []).forEach(function (r) {
          (d.fields || []).forEach(function (f) {
            var v = r[f.key];
            if (v === null || v === undefined) return;
            add(v);
            if (f.role === 'measure') { add(fmt(v, f, { compact: true })); add(fmt(v, f, { compact: false })); add(fmt(v, f, {})); }
            else add(label(v, f));
          });
        });
        // A total the report's code adds up is NOT a BI Core value: it is not allowed here, so
        // the audit flags it (bind a KPI for an official total).
      });
      // Association audit: a number may equal a real value and still sit in the wrong
      // row ("RJ" showing SP's figure) or under the wrong metric. Index every row value
      // by its formatted text, then read each on-screen number in its row / card.
      var where = {};   // formatted → [{id, row label, measure label, title}]
      var labelsOf = {}; // binding id → dimension labels
      var measureLabels = {};
      Object.keys(cache).forEach(function (id) {
        var d = cache[id], dim = dims(d)[0];
        labelsOf[id] = dim ? (d.rows || []).map(function (r) { return String(label(r[dim.key], dim)); }) : [];
        measures(d).forEach(function (f) {
          measureLabels[f.label] = 1;
          (d.rows || []).forEach(function (r) {
            [fmt(r[f.key], f, { compact: true }), fmt(r[f.key], f, { compact: false }), fmt(r[f.key], f, {})].forEach(function (s) {
              var k = String(s).replace(/\s+/g, '');
              (where[k] = where[k] || []).push({ id: id, row: dim ? String(label(r[dim.key], dim)) : null, measure: f.label, title: d.title || id });
            });
          });
        });
      });
      var assoc = [];
      var checkAssoc = function (el, token) {
        var hits = where[token.replace(/\s+/g, '')];
        if (!hits) return;
        var rowEl = el.closest('tr,li,[role=row]');
        if (rowEl) {
          var rowText = rowEl.innerText || rowEl.textContent || '';
          hits.forEach(function (h) {
            if (!h.row) return;
            var shown = (labelsOf[h.id] || []).filter(function (l) { return l.length > 1 && l !== h.row && new RegExp('(^|[^\\w])' + l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^\\w]|$)').test(rowText); });
            var own = new RegExp('(^|[^\\w])' + h.row.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^\\w]|$)').test(rowText);
            if (shown.length && !own && hits.every(function (o) { return o.row !== shown[0]; })) {
              assoc.push('dòng "' + shown[0] + '" hiển thị ' + token + ' — đó là giá trị của "' + h.row + '" (' + h.title + ')');
            }
          });
        }
        var card = el.closest('.card,[class*="card"],[class*="kpi"],[class*="stat"]');
        if (card && !rowEl) {
          var cardText = (card.innerText || '').slice(0, 160);
          var mine = hits.some(function (h) { return cardText.indexOf(h.measure) >= 0 || cardText.indexOf(h.title) >= 0; });
          var other = Object.keys(measureLabels).filter(function (l) { return l.length > 3 && cardText.indexOf(l) >= 0; });
          if (!mine && other.length && hits.every(function (h) { return other.indexOf(h.measure) < 0; })) {
            assoc.push('thẻ ghi "' + other[0] + '" nhưng số ' + token + ' là "' + hits[0].measure + '" (' + hits[0].title + ')');
          }
        }
      };
      var vals = document.querySelectorAll('[data-rac-value]');
      for (var vi = 0; vi < vals.length; vi++) {
        var ve = vals[vi], tv = (ve.textContent || '').trim();
        if (tv && tv !== '…' && tv !== '—') checkAssoc(ve, tv);
        var vrow = ve.closest('tr,li,[role=row]'), vid = ve.getAttribute('data-rac-value');
        if (vrow && !ve.hasAttribute('data-rac-row') && !ve.hasAttribute('data-rac-rank')) {
          var vtext = vrow.innerText || '';
          var lab = (labelsOf[vid] || []).filter(function (l) { return l.length > 1 && vtext.indexOf(l) >= 0; })[0];
          if (lab) assoc.push('dòng "' + lab + '" hiển thị số tổng/đầu bảng của "' + ((cache[vid] && cache[vid].title) || vid) + '" thay vì giá trị của chính dòng đó (thêm data-rac-row="' + lab + '")');
        }
      }

      var bad = [], marked = 0;
      var stale = document.querySelectorAll('.rac-static');
      for (var si = 0; si < stale.length; si++) stale[si].classList.remove('rac-static');
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (var node = walker.nextNode(); node && marked < 120; node = walker.nextNode()) {
        var el = node.parentElement;
        if (!el || el.closest(TRUSTED)) continue;
        var toks = String(node.nodeValue || '').replace(DATE_RX, ' ').match(/[-+]?\d[\d.,]*\s?(?:Tr|Tỷ|tỷ|N|K|M|B|%|₫)?/g) || [];
        toks.forEach(function (tok) {
          // the sentence's own punctuation is not part of the figure ("mốc 2026." -> 2026)
          var t = tok.replace(/\s+/g, '').replace(/^[.,]+|[.,]+$/g, '');
          var n = parseFloat(t.replace(/\./g, '').replace(',', '.'));
          if (!isFinite(n)) return;
          // FIRST the numbers that are not figures - a rank, a month, a day, a year: equal
          // to some bound value by chance ("Top 10" vs a row worth 10) they are no misplacement
          if (/^\d{4}$/.test(t) && n >= 1900 && n <= 2100) return;   // years in headings
          if (/^\d{1,2}$/.test(t) && n <= 31) return;                // ranks, months, days
          if (allowed[t]) { checkAssoc(el, t); return; }
          if (!el.classList.contains('rac-static')) { el.classList.add('rac-static'); marked++; }
          if (bad.indexOf(t) < 0 && bad.length < 6) bad.push(t);
        });
      }
      assoc = assoc.filter(function (x, i) { return assoc.indexOf(x) === i; });
      var akey = 'a:' + assoc.join('|');
      if (assoc.length && !auditSeen[akey]) {
        auditSeen[akey] = 1;
        report('semantic', 'Giá trị đúng nhưng đặt sai chỗ: ' + assoc.slice(0, 4).join('; ') +
          '. Với bảng tự dựng hãy dùng data-rac-row / data-rac-rank; với thẻ, gắn đúng binding của chỉ số được ghi.');
      }
      var key = bad.join('|');
      if (bad.length && !auditSeen[key]) {
        auditSeen[key] = 1;
        report('provenance', 'Số hiển thị không khớp giá trị nào của dữ liệu đã gắn: ' + bad.join(', ') +
          ' — nếu là số tự viết hoặc tự tính trong mã, hãy hiển thị bằng data-rac-value / rac.viz, hoặc kiểm tra lại cách lấy giá trị.');
      }
    }, 2500);
  }
  var lastW = 0, resizeT = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeT);
    resizeT = setTimeout(function () { if (Math.abs(window.innerWidth - lastW) > 8) { lastW = window.innerWidth; var vz = document.querySelectorAll('[data-rac-viz]'); for (var i = 0; i < vz.length; i++) renderViz(vz[i]); } }, 120);
  });

  // ── 8. Icons (inline SVG; no external assets are reachable) ─────────────────────
  var ICONS = {
    home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10', chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2', trend: 'M3 17l6-6 4 4 8-8M15 7h6v6',
    users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
    cart: 'M3 3h2l2.4 12.4a2 2 0 0 0 2 1.6h8.8a2 2 0 0 0 2-1.6L22 7H6M9 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2M18 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2',
    money: 'M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6', truck: 'M1 3h15v13H1zM16 8h4l3 3v5h-7M5.5 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M18.5 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5',
    star: 'M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.2-6.2 3.2L7 14.2 2 9.3l6.9-1z', box: 'M21 16V8l-9-5-9 5v8l9 5 9-5zM3.3 7L12 12l8.7-5M12 22V12',
    layers: 'M12 2l10 5-10 5L2 7zM2 17l10 5 10-5M2 12l10 5 10-5', filter: 'M22 3H2l8 9.5V19l4 2v-8.5z', calendar: 'M3 4h18v18H3zM16 2v4M8 2v4M3 10h18',
    map: 'M1 6v16l7-4 8 4 7-4V2l-7 4-8-4zM8 2v16M16 6v16', target: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
    table: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18', pie: 'M21.2 15.9A10 10 0 1 1 8 2.8M22 12A10 10 0 0 0 12 2v10z', menu: 'M3 6h18M3 12h18M3 18h18',
    up: 'M12 19V5M5 12l7-7 7 7', down: 'M12 5v14M19 12l-7 7-7-7', alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'
  };
  function icon(name, sz) { var p = ICONS[name] || ICONS.chart; return '<svg class="rac-icon" width="' + (sz || 18) + '" height="' + (sz || 18) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="' + p + '"/></svg>'; }
  function mountIcons() { var is = document.querySelectorAll('[data-rac-icon]:not([data-rac-im])'); for (var i = 0; i < is.length; i++) { is[i].setAttribute('data-rac-im', '1'); is[i].innerHTML = icon(is[i].getAttribute('data-rac-icon'), parseInt(is[i].getAttribute('data-rac-size') || '0', 10) || undefined); } }

  // ── 9. Public API ──────────────────────────────────────────────────────────────
  var api = {
    version: VERSION,
    bind: function (id, fn) { (subs[id] = subs[id] || []).push(fn); checkNeed(); if (cache[id]) safe(fn, cache[id]); return function () { subs[id] = (subs[id] || []).filter(function (f) { return f !== fn; }); }; },
    data: function (id) { return cache[id] || null; },
    bindings: function () { return ctx.bindings.slice(); },
    filters: function () { return ctx.filters.slice(); },
    filterState: function () { var o = {}; Object.keys(ctx.state || {}).forEach(function (k) { o[k] = ctx.state[k]; }); return o; },
    onFilters: function (fn) { filterSubs.push(fn); return function () { filterSubs = filterSubs.filter(function (f) { return f !== fn; }); }; },
    setFilter: setFilter,
    clearFilter: function (key) { setFilter(key, null); },
    clearFilters: function () { send({ type: 'clearFilters' }); },
    values: values,
    drill: function (key, value) {
      var decl = filterDecl(key); if (!decl) { report('filter', 'Unknown filter "' + key + '"'); return; }
      var cur = ctx.state[key], s = String(value);
      setFilter(key, Array.isArray(cur) && cur.length === 1 && String(cur[0]) === s ? null : [s]);
    },
    ready: function (fn) { if (port) safe(fn); else readySubs.push(fn); },
    fmt: fmt, fmtDate: fmtDate, label: label,
    fields: function (src) { var d = dtoOf(src); return d ? (d.fields || []).slice() : []; },
    primary: function (src, o) { var d = dtoOf(src); return d ? primary(d, o) : null; },
    viz: {},
    icon: icon,
    errors: function () { return errors.slice(); },
    guarded: function () { return settleGuard(); },
    // Called once by the document with the report's own script.
    __author: function (fn) {
      if (authorState !== 'none') return;
      authorState = 'pending';
      setTimeout(function () {
        if (!settleGuard()) {
          authorState = 'refused';
          report('js_off', 'JavaScript tùy biến của báo cáo chưa chạy (báo cáo KHÔNG lỗi): môi trường này chưa có origin báo cáo riêng '
            + '(REPORT_ARTIFACT_ORIGIN) hoặc trình duyệt thiếu Navigation API. Dữ liệu, biểu đồ, bộ lọc và CSS vẫn chạy bình thường.');
          send({ type: 'guard', guard: false, authorScript: authorState });
          return;
        }
        authorState = 'ran';
        try { fn.call(window); } catch (err) { report('script', err && err.message ? err.message : String(err)); }
        send({ type: 'guard', guard: true, authorScript: authorState });
      }, 0);
    }
  };
  Object.keys(viz).forEach(function (k) {
    api.viz[k] = function (el, src, o) {
      if (typeof el === 'string') el = document.querySelector(el);
      if (!el) return;
      var draw = function (d) { try { viz[k](el, d, o || {}); } catch (err) { report('render', k + ': ' + err.message); } };
      if (typeof src === 'string') { draw(cache[src] || { status: 'loading', bindingId: src }); return api.bind(src, draw); }
      draw(src);
      return function () {};
    };
  });
  Object.freeze(api.viz);
  Object.defineProperty(window, 'rac', { value: Object.freeze(api), writable: false, configurable: false });

  document.addEventListener('DOMContentLoaded', function () { lastW = window.innerWidth; mountIcons(); scheduleMount(); });
  new MutationObserver(function () { mountIcons(); }).observe(document.documentElement, { childList: true, subtree: true });
})();
