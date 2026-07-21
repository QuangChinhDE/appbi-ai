/**
 * Compact, dependency-free Markdown → React renderer for dashboard text widgets.
 *
 * Covers the GFM subset a BI text/annotation widget actually needs:
 *   - headings (#..######), horizontal rules (---, ***, ___)
 *   - GFM tables (with :--- / :---: / ---: column alignment)
 *   - unordered lists (-, *, +) and ordered lists (1. / 1))
 *   - blockquotes (> )
 *   - fenced code blocks (``` … ```)
 *   - inline: **bold** __bold__, *italic* _italic_, `code`, [label](url),
 *     literal <br> / <br/> line breaks
 *
 * SAFETY: every node is built as a real React element — we NEVER use
 * `dangerouslySetInnerHTML`, so user markdown can't inject script/HTML.
 * Link hrefs are passed through `safeHref` which drops `javascript:` and
 * other non-http(s)/mailto schemes.
 *
 * Paragraph model: a single source newline is a hard line break (each
 * non-structural line renders on its own row). This matches how users treat
 * a dashboard text box and preserves the previous widget's behaviour, while
 * adding the block/inline grammar that was missing.
 */
import React from 'react';

/** Allow only safe link schemes; anything else renders as plain text. */
function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (/^(https?:|mailto:|tel:)/i.test(url)) return url;
  // allow protocol-relative and site-relative links
  if (/^(\/|#|\.\/|\.\.\/)/.test(url)) return url;
  if (/^www\./i.test(url)) return `https://${url}`;
  return null;
}

/** Parse the inline grammar of a single text run into React nodes. */
function parseInline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let buf = '';
  let i = 0;
  let k = 0;
  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = '';
    }
  };
  const push = (node: React.ReactNode) => {
    flush();
    out.push(node);
  };

  while (i < text.length) {
    const rest = text.slice(i);
    let m: RegExpExecArray | null;

    // literal <br> / <br/> → hard line break
    if ((m = /^<br\s*\/?>/i.exec(rest))) {
      push(<br key={`${keyBase}-br-${k++}`} />);
      i += m[0].length;
      continue;
    }
    // inline code — contents are literal, no further parsing
    if ((m = /^`([^`]+)`/.exec(rest))) {
      push(
        <code
          key={`${keyBase}-code-${k++}`}
          className="rounded bg-surface-3 px-1 py-0.5 font-mono text-[0.85em]"
        >
          {m[1]}
        </code>,
      );
      i += m[0].length;
      continue;
    }
    // bold (** ** or __ __) — matched before italic so ** wins over *
    if ((m = /^\*\*([\s\S]+?)\*\*/.exec(rest)) || (m = /^__([\s\S]+?)__/.exec(rest))) {
      push(
        <strong key={`${keyBase}-b-${k++}`}>{parseInline(m[1], `${keyBase}-b-${k}`)}</strong>,
      );
      i += m[0].length;
      continue;
    }
    // italic (* * or _ _)
    if ((m = /^\*([^*\n]+?)\*/.exec(rest)) || (m = /^_([^_\n]+?)_/.exec(rest))) {
      push(<em key={`${keyBase}-i-${k++}`}>{parseInline(m[1], `${keyBase}-i-${k}`)}</em>);
      i += m[0].length;
      continue;
    }
    // link [label](href)
    if ((m = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest))) {
      const href = safeHref(m[2]);
      const label = m[1] || m[2];
      if (href) {
        push(
          <a
            key={`${keyBase}-a-${k++}`}
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-brand underline underline-offset-2 hover:text-brand-hover"
          >
            {parseInline(label, `${keyBase}-a-${k}`)}
          </a>,
        );
      } else {
        buf += m[0]; // unsafe scheme → keep literal
      }
      i += m[0].length;
      continue;
    }

    buf += text[i];
    i += 1;
  }
  flush();
  return out;
}

/** GFM table separator row, e.g. `|---|:--:|--:|` or `--- | ---`. */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('-') || !trimmed.includes('|')) return false;
  const cells = splitRow(trimmed);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

/** Split a `|`-delimited table row, dropping the empty edges from leading/trailing pipes. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  // split on unescaped pipes
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|'));
}

type Align = 'left' | 'center' | 'right';

function alignOf(spec: string): Align {
  const s = spec.trim();
  const l = s.startsWith(':');
  const r = s.endsWith(':');
  if (l && r) return 'center';
  if (r) return 'right';
  return 'left';
}

/**
 * Render Markdown source to React nodes. Returns a fragment; the caller
 * supplies the outer padding / typography wrapper.
 */
export function renderMarkdown(src: string): React.ReactNode {
  if (!src) return null;
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // blank line → small vertical gap
    if (!trimmed) {
      blocks.push(<div key={`bl-${key++}`} className="h-2" />);
      i += 1;
      continue;
    }

    // fenced code block ``` … ```
    const fence = /^(```|~~~)(.*)$/.exec(trimmed);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // skip closing fence
      blocks.push(
        <pre
          key={`code-${key++}`}
          className="overflow-x-auto rounded-md bg-surface-3 p-2 font-mono text-[0.85em] leading-snug"
        >
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // horizontal rule
    if (/^([-*_])\1{2,}$/.test(trimmed.replace(/\s+/g, ''))) {
      blocks.push(<hr key={`hr-${key++}`} className="my-2 border-[rgb(var(--border-line))]" />);
      i += 1;
      continue;
    }

    // heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      const cls =
        level === 1
          ? 'text-xl font-semibold leading-tight'
          : level === 2
            ? 'text-lg font-semibold leading-tight'
            : level === 3
              ? 'text-base font-semibold leading-snug'
              : 'text-sm font-semibold leading-snug';
      blocks.push(
        <div key={`h-${key++}`} className={cls}>
          {parseInline(heading[2], `h${key}`)}
        </div>,
      );
      i += 1;
      continue;
    }

    // GFM table: current line + separator on the next line
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(alignOf);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push(
        <div key={`tbl-${key++}`} className="overflow-x-auto">
          <table className="w-full border-collapse text-[0.9em]">
            <thead>
              <tr>
                {header.map((cell, ci) => (
                  <th
                    key={ci}
                    className="border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1 font-semibold"
                    style={{ textAlign: aligns[ci] ?? 'left' }}
                  >
                    {parseInline(cell.trim(), `th-${key}-${ci}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>
                  {header.map((_, ci) => (
                    <td
                      key={ci}
                      className="border border-[rgb(var(--border-line))] px-2 py-1 align-top"
                      style={{ textAlign: aligns[ci] ?? 'left' }}
                    >
                      {parseInline((row[ci] ?? '').trim(), `td-${key}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // blockquote (consecutive `> ` lines)
    if (/^>\s?/.test(trimmed)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quote.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push(
        <blockquote
          key={`q-${key++}`}
          className="border-l-2 border-[rgb(var(--border-strong))] pl-3 text-text-secondary"
        >
          {quote.map((q, qi) => (
            <div key={qi} className="whitespace-pre-wrap leading-snug">
              {parseInline(q, `q-${key}-${qi}`)}
            </div>
          ))}
        </blockquote>,
      );
      continue;
    }

    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i += 1;
      }
      blocks.push(
        <ul key={`ul-${key++}`} className="list-disc space-y-0.5 pl-5">
          {items.map((it, ii) => (
            <li key={ii} className="leading-snug">
              {parseInline(it, `ul-${key}-${ii}`)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // ordered list (1. or 1))
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      let start = 1;
      const first = /^\s*(\d+)[.)]\s+/.exec(line);
      if (first) start = Number(first[1]) || 1;
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i += 1;
      }
      blocks.push(
        <ol key={`ol-${key++}`} start={start} className="list-decimal space-y-0.5 pl-5">
          {items.map((it, ii) => (
            <li key={ii} className="leading-snug">
              {parseInline(it, `ol-${key}-${ii}`)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    // paragraph line (one source line == one rendered line)
    blocks.push(
      <div key={`p-${key++}`} className="whitespace-pre-wrap leading-snug">
        {parseInline(line, `p${key}`)}
      </div>,
    );
    i += 1;
  }

  return <div className="space-y-1 break-words">{blocks}</div>;
}
