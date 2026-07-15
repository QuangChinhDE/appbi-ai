/**
 * Mini expression evaluator for workboard show_if / required_if / readonly_if.
 *
 * Mirrors ``backend/app/modules/workboards/services/expr_eval.py`` so client
 * and server agree on the same grammar — the dataset transformation
 * grammar IT/DE already learned.
 *
 *   Literals    1.5  "string"  true/false  null
 *   Refs        [col]   bare_name   {{app_user.x}}   {{shared.x}}   {{today}}   {{now}}
 *   Operators   == != > >= < <=  &&  ||  + - * /
 *   Functions   IF(cond, then, else)  COALESCE(a,b,...)  ROUND(x[,n])  ABS(x)
 *               CEIL(x)  FLOOR(x)  GREATEST(a,b,...)  LEAST(a,b,...)
 *               NULLIF(a,b)  IN(value, a, b, ...)  NOT(expr)
 *
 * Failures return ``null`` so a malformed expression in the layout never
 * breaks the form — the rule simply doesn't fire.
 */

export interface EvalContext {
  row: Record<string, unknown>;
  app_user: Record<string, unknown>;
  shared: Record<string, unknown>;
}

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'col'; value: string }
  | { kind: 'ph'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'ident'; value: string }
  | { kind: 'end' };

const TOKEN_RE = /\s*(?:(-?\d+(?:\.\d+)?)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\[[^\]]+\])|(\{\{[^}]+\}\})|(==|!=|>=|<=|&&|\|\||[+\-*/<>(),])|([A-Za-z_][A-Za-z0-9_]*))/y;

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  while (pos < expr.length) {
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(expr);
    if (!m) {
      // Skip whitespace
      if (/\s/.test(expr[pos])) {
        pos++;
        continue;
      }
      throw new Error(`Unexpected ${expr.slice(pos, pos + 10)}`);
    }
    if (m[1] !== undefined) {
      tokens.push({ kind: 'num', value: parseFloat(m[1]) });
    } else if (m[2] !== undefined) {
      tokens.push({ kind: 'str', value: m[2].slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'") });
    } else if (m[3] !== undefined) {
      tokens.push({ kind: 'col', value: m[3].slice(1, -1).trim() });
    } else if (m[4] !== undefined) {
      tokens.push({ kind: 'ph', value: m[4].slice(2, -2).trim() });
    } else if (m[5] !== undefined) {
      tokens.push({ kind: 'op', value: m[5] });
    } else if (m[6] !== undefined) {
      tokens.push({ kind: 'ident', value: m[6] });
    }
    pos = TOKEN_RE.lastIndex;
  }
  tokens.push({ kind: 'end' });
  return tokens;
}

type Node =
  | { type: 'num'; value: number }
  | { type: 'str'; value: string }
  | { type: 'bool'; value: boolean }
  | { type: 'null' }
  | { type: 'col'; name: string }
  | { type: 'ph'; path: string }
  | { type: 'neg'; arg: Node }
  | { type: 'op'; op: string; a: Node; b: Node }
  | { type: 'call'; name: string; args: Node[] };

class Parser {
  idx = 0;
  constructor(public tokens: Token[]) {}
  peek(): Token {
    return this.tokens[this.idx];
  }
  consume(): Token {
    return this.tokens[this.idx++];
  }
  expect(op: string) {
    const t = this.consume();
    if (t.kind !== 'op' || t.value !== op) throw new Error(`Expected ${op}`);
  }
  parse(): Node {
    const n = this.or();
    if (this.peek().kind !== 'end') throw new Error('Trailing tokens');
    return n;
  }
  or(): Node {
    let a = this.and();
    while (this.peek().kind === 'op' && (this.peek() as any).value === '||') {
      this.consume();
      a = { type: 'op', op: '||', a, b: this.and() };
    }
    return a;
  }
  and(): Node {
    let a = this.cmp();
    while (this.peek().kind === 'op' && (this.peek() as any).value === '&&') {
      this.consume();
      a = { type: 'op', op: '&&', a, b: this.cmp() };
    }
    return a;
  }
  cmp(): Node {
    let a = this.add();
    while (this.peek().kind === 'op' && ['==', '!=', '>', '>=', '<', '<='].includes((this.peek() as any).value)) {
      const op = (this.consume() as any).value;
      a = { type: 'op', op, a, b: this.add() };
    }
    return a;
  }
  add(): Node {
    let a = this.mul();
    while (this.peek().kind === 'op' && ['+', '-'].includes((this.peek() as any).value)) {
      const op = (this.consume() as any).value;
      a = { type: 'op', op, a, b: this.mul() };
    }
    return a;
  }
  mul(): Node {
    let a = this.unary();
    while (this.peek().kind === 'op' && ['*', '/'].includes((this.peek() as any).value)) {
      const op = (this.consume() as any).value;
      a = { type: 'op', op, a, b: this.unary() };
    }
    return a;
  }
  unary(): Node {
    if (this.peek().kind === 'op' && (this.peek() as any).value === '-') {
      this.consume();
      return { type: 'neg', arg: this.unary() };
    }
    return this.atom();
  }
  atom(): Node {
    const t = this.consume();
    if (t.kind === 'num') return { type: 'num', value: t.value };
    if (t.kind === 'str') return { type: 'str', value: t.value };
    if (t.kind === 'col') return { type: 'col', name: t.value };
    if (t.kind === 'ph') return { type: 'ph', path: t.value };
    if (t.kind === 'op' && t.value === '(') {
      const inner = this.or();
      this.expect(')');
      return inner;
    }
    if (t.kind === 'ident') {
      const name = t.value;
      if (this.peek().kind === 'op' && (this.peek() as any).value === '(') {
        this.consume();
        const args: Node[] = [];
        if (!(this.peek().kind === 'op' && (this.peek() as any).value === ')')) {
          args.push(this.or());
          while (this.peek().kind === 'op' && (this.peek() as any).value === ',') {
            this.consume();
            args.push(this.or());
          }
        }
        this.expect(')');
        return { type: 'call', name: name.toUpperCase(), args };
      }
      const up = name.toUpperCase();
      if (up === 'TRUE') return { type: 'bool', value: true };
      if (up === 'FALSE') return { type: 'bool', value: false };
      if (up === 'NULL') return { type: 'null' };
      return { type: 'col', name };
    }
    throw new Error('Unexpected token');
  }
}

function coerceNumber(v: unknown): number | null {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s !== '' && s !== 'false' && s !== '0' && s !== 'null' && s !== 'none';
  }
  return Boolean(v);
}

function resolvePlaceholder(path: string, ctx: EvalContext): unknown {
  if (path === 'today') return new Date().toISOString().slice(0, 10);
  if (path === 'now') return new Date().toISOString();
  const parts = path.split('.');
  let cursor: any = ctx;
  for (const p of parts) {
    if (cursor && typeof cursor === 'object' && p in cursor) cursor = cursor[p];
    else return null;
  }
  return cursor;
}

function evalNode(node: Node, ctx: EvalContext): unknown {
  switch (node.type) {
    case 'num':
    case 'str':
    case 'bool':
      return node.value;
    case 'null':
      return null;
    case 'col': {
      const row = ctx.row || {};
      return node.name in row ? row[node.name] : null;
    }
    case 'ph':
      return resolvePlaceholder(node.path, ctx);
    case 'neg': {
      const v = coerceNumber(evalNode(node.arg, ctx));
      return v === null ? null : -v;
    }
    case 'op': {
      if (node.op === '&&') return truthy(evalNode(node.a, ctx)) && truthy(evalNode(node.b, ctx));
      if (node.op === '||') return truthy(evalNode(node.a, ctx)) || truthy(evalNode(node.b, ctx));
      const av = evalNode(node.a, ctx);
      const bv = evalNode(node.b, ctx);
      if (node.op === '==') return av === bv || (av != null && bv != null && String(av) === String(bv));
      if (node.op === '!=') return !(av === bv || (av != null && bv != null && String(av) === String(bv)));
      if (['>', '>=', '<', '<='].includes(node.op)) {
        const an = coerceNumber(av);
        const bn = coerceNumber(bv);
        if (an !== null && bn !== null) {
          if (node.op === '>') return an > bn;
          if (node.op === '>=') return an >= bn;
          if (node.op === '<') return an < bn;
          if (node.op === '<=') return an <= bn;
        }
        if (typeof av === 'string' && typeof bv === 'string') {
          if (node.op === '>') return av > bv;
          if (node.op === '>=') return av >= bv;
          if (node.op === '<') return av < bv;
          if (node.op === '<=') return av <= bv;
        }
        return false;
      }
      const an = coerceNumber(av);
      const bn = coerceNumber(bv);
      if (an === null || bn === null) return null;
      if (node.op === '+') return an + bn;
      if (node.op === '-') return an - bn;
      if (node.op === '*') return an * bn;
      if (node.op === '/') return bn === 0 ? null : an / bn;
      return null;
    }
    case 'call': {
      const args = node.args.map((a) => evalNode(a, ctx));
      const N = node.name;
      if (N === 'IF') {
        const c = args[0];
        return truthy(c) ? args[1] : args[2] ?? null;
      }
      if (N === 'COALESCE') {
        for (const v of args) if (v !== null && v !== undefined) return v;
        return null;
      }
      if (N === 'ROUND') {
        const x = coerceNumber(args[0]);
        const d = Math.trunc(coerceNumber(args[1]) ?? 0);
        if (x === null) return null;
        const f = Math.pow(10, d);
        return Math.round(x * f) / f;
      }
      if (N === 'ABS') {
        const x = coerceNumber(args[0]);
        return x === null ? null : Math.abs(x);
      }
      if (N === 'CEIL') {
        const x = coerceNumber(args[0]);
        return x === null ? null : Math.ceil(x);
      }
      if (N === 'FLOOR') {
        const x = coerceNumber(args[0]);
        return x === null ? null : Math.floor(x);
      }
      if (N === 'GREATEST' || N === 'LEAST') {
        const nums = args.map(coerceNumber).filter((v): v is number => v !== null);
        if (!nums.length) return null;
        return N === 'GREATEST' ? Math.max(...nums) : Math.min(...nums);
      }
      if (N === 'NULLIF') {
        if (args.length >= 2 && args[0] === args[1]) return null;
        return args[0];
      }
      if (N === 'IN') {
        if (!args.length) return false;
        const target = args[0];
        return args.slice(1).some((v) => v === target || String(v) === String(target));
      }
      if (N === 'NOT') return !truthy(args[0]);
      if (N === 'AND') return args.every((v) => truthy(v));
      if (N === 'OR') return args.some((v) => truthy(v));
      if (N === 'ISBLANK') {
        const v = args[0];
        return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
      }
      // Text
      if (N === 'CONCAT') return args.map((v) => (v === null || v === undefined ? '' : String(v))).join('');
      if (N === 'UPPER') return args[0] == null ? null : String(args[0]).toUpperCase();
      if (N === 'LOWER') return args[0] == null ? null : String(args[0]).toLowerCase();
      if (N === 'TRIM') return args[0] == null ? null : String(args[0]).trim();
      if (N === 'LEN') return args[0] == null ? 0 : String(args[0]).length;
      if (N === 'LEFT') {
        const s = args[0] == null ? '' : String(args[0]);
        const n = Math.trunc(coerceNumber(args[1]) ?? 0);
        return s.slice(0, Math.max(n, 0));
      }
      if (N === 'RIGHT') {
        const s = args[0] == null ? '' : String(args[0]);
        const n = Math.trunc(coerceNumber(args[1]) ?? 0);
        return n > 0 ? s.slice(-n) : '';
      }
      if (N === 'CONTAINS') {
        const hay = args[0] == null ? '' : String(args[0]);
        const needle = args[1] == null ? '' : String(args[1]);
        return hay.includes(needle);
      }
      // Math
      if (N === 'MOD') {
        const a = coerceNumber(args[0]);
        const b = coerceNumber(args[1]);
        return a === null || !b ? null : a % b;
      }
      if (N === 'POWER') {
        const a = coerceNumber(args[0]);
        const b = coerceNumber(args[1]);
        return a === null || b === null ? null : a ** b;
      }
      // Date parts (ISO string)
      if (N === 'YEAR' || N === 'MONTH' || N === 'DAY') {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(args[0] == null ? '' : String(args[0]));
        if (!m) return null;
        return Number(m[{ YEAR: 1, MONTH: 2, DAY: 3 }[N] as 1 | 2 | 3]);
      }
      return null;
    }
  }
}

export function evaluateExpr(expression: string | null | undefined, ctx: EvalContext): unknown {
  if (!expression) return null;
  try {
    const tokens = tokenize(expression);
    return evalNode(new Parser(tokens).parse(), ctx);
  } catch {
    return null;
  }
}

export function evaluateTruthy(expression: string | null | undefined, ctx: EvalContext, defaultValue = true): boolean {
  if (!expression) return defaultValue;
  return truthy(evaluateExpr(expression, ctx));
}
