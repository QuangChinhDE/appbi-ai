/**
 * Workboard grid formula engine — TypeScript twin of the backend evaluator.
 *
 * The same Sheets-style subset (arithmetic, comparisons, logic, ~25
 * whitelisted functions) so the runtime can preview computed cells
 * optimistically while the user types. The backend remains source of
 * truth — it re-evaluates every formula on save, and a divergence between
 * the two engines surfaces as "client guess says X, server returned Y"
 * on the next refresh (intentional; the server wins).
 *
 * Why a hand-rolled parser instead of pulling a generic JS expression
 * library: every external evaluator I tried either ran inside `eval()`
 * (RCE risk if a future feature exposes user-generated formulas to other
 * tenants) or had a bundle weight measured in tens of KB. This file is
 * ~12 KB and uses zero runtime deps.
 */

export class FormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormulaError';
  }
}

type Token =
  | { type: 'num'; value: number }
  | { type: 'str'; value: string }
  | { type: 'bool'; value: boolean }
  | { type: 'null' }
  | { type: 'ident'; value: string }
  | { type: 'op'; value: string }
  | { type: 'paren'; value: '(' | ')' }
  | { type: 'comma' };

// ─── Lexer ────────────────────────────────────────────────────────────────

function tokenize(source: string): Token[] {
  const text = source.trim().replace(/^=\s*/, '');
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    // Numbers (including decimals).
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] || ''))) {
      let j = i + 1;
      let dot = ch === '.';
      while (j < text.length) {
        const c = text[j];
        if (c === '.' && !dot) {
          dot = true;
          j += 1;
          continue;
        }
        if (!/[0-9]/.test(c)) break;
        j += 1;
      }
      tokens.push({ type: 'num', value: Number(text.slice(i, j)) });
      i = j;
      continue;
    }
    // String literals — single or double quoted, with backslash escape.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let value = '';
      while (j < text.length && text[j] !== quote) {
        if (text[j] === '\\' && j + 1 < text.length) {
          value += text[j + 1];
          j += 2;
          continue;
        }
        value += text[j];
        j += 1;
      }
      if (j >= text.length) {
        throw new FormulaError('Unterminated string literal');
      }
      tokens.push({ type: 'str', value });
      i = j + 1;
      continue;
    }
    // Identifiers / keywords.
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j += 1;
      const ident = text.slice(i, j);
      const lower = ident.toLowerCase();
      if (lower === 'true') tokens.push({ type: 'bool', value: true });
      else if (lower === 'false') tokens.push({ type: 'bool', value: false });
      else if (lower === 'null' || lower === 'none') tokens.push({ type: 'null' });
      else if (lower === 'and') tokens.push({ type: 'op', value: '&&' });
      else if (lower === 'or') tokens.push({ type: 'op', value: '||' });
      else if (lower === 'not') tokens.push({ type: 'op', value: '!' });
      else tokens.push({ type: 'ident', value: ident });
      i = j;
      continue;
    }
    // Multi-char operators first.
    const two = text.slice(i, i + 2);
    if (
      two === '==' ||
      two === '!=' ||
      two === '<>' ||
      two === '<=' ||
      two === '>=' ||
      two === '&&' ||
      two === '||' ||
      two === '**'
    ) {
      tokens.push({
        type: 'op',
        value: two === '<>' ? '!=' : two,
      });
      i += 2;
      continue;
    }
    if ('+-*/%^<>=!&'.includes(ch)) {
      const normalised = ch === '=' ? '==' : ch === '^' ? '**' : ch;
      tokens.push({ type: 'op', value: normalised });
      i += 1;
      continue;
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', value: ch });
      i += 1;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma' });
      i += 1;
      continue;
    }
    throw new FormulaError(`Unexpected character: ${ch}`);
  }
  return tokens;
}

// ─── Parser (Pratt-style precedence climb) ────────────────────────────────

type Node =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'ref'; name: string }
  | { kind: 'unary'; op: '+' | '-' | '!'; operand: Node }
  | { kind: 'binary'; op: string; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[] };

const PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3, '!=': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
  '**': 7,
};

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.parseExpression(0);
    if (this.pos < this.tokens.length) {
      throw new FormulaError('Unexpected token after expression');
    }
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(): Token {
    const tok = this.tokens[this.pos];
    if (!tok) throw new FormulaError('Unexpected end of expression');
    this.pos += 1;
    return tok;
  }

  private parseExpression(minPrec: number): Node {
    let left = this.parseUnary();
    while (true) {
      const tok = this.peek();
      if (!tok || tok.type !== 'op') break;
      const prec = PRECEDENCE[tok.value];
      if (prec === undefined || prec < minPrec) break;
      this.consume();
      // Right-associative for `**` (exponent); left for everything else.
      const nextMin = tok.value === '**' ? prec : prec + 1;
      const right = this.parseExpression(nextMin);
      left = { kind: 'binary', op: tok.value, left, right };
    }
    return left;
  }

  private parseUnary(): Node {
    const tok = this.peek();
    if (tok && tok.type === 'op' && (tok.value === '+' || tok.value === '-' || tok.value === '!')) {
      this.consume();
      const operand = this.parseUnary();
      return { kind: 'unary', op: tok.value as '+' | '-' | '!', operand };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const tok = this.consume();
    if (tok.type === 'num') return { kind: 'num', value: tok.value };
    if (tok.type === 'str') return { kind: 'str', value: tok.value };
    if (tok.type === 'bool') return { kind: 'bool', value: tok.value };
    if (tok.type === 'null') return { kind: 'null' };
    if (tok.type === 'paren' && tok.value === '(') {
      const node = this.parseExpression(0);
      const closer = this.consume();
      if (closer.type !== 'paren' || closer.value !== ')') {
        throw new FormulaError('Expected )');
      }
      return node;
    }
    if (tok.type === 'ident') {
      const next = this.peek();
      if (next && next.type === 'paren' && next.value === '(') {
        this.consume();
        const args: Node[] = [];
        let first = true;
        while (true) {
          const lookahead = this.peek();
          if (!lookahead) throw new FormulaError('Expected ) after arguments');
          if (lookahead.type === 'paren' && lookahead.value === ')') {
            this.consume();
            break;
          }
          if (!first) {
            const sep = this.consume();
            if (sep.type !== 'comma') throw new FormulaError('Expected , between arguments');
          }
          args.push(this.parseExpression(0));
          first = false;
        }
        return { kind: 'call', name: tok.value.toUpperCase(), args };
      }
      return { kind: 'ref', name: tok.value };
    }
    throw new FormulaError(`Unexpected token: ${JSON.stringify(tok)}`);
  }
}

// ─── Function registry ────────────────────────────────────────────────────

function toNum(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  const n = Number(value);
  if (Number.isNaN(n)) throw new FormulaError(`Expected a number, got ${String(value)}`);
  return n;
}

function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return true;
}

function flatten(values: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const v of values) {
    if (Array.isArray(v)) out.push(...flatten(v));
    else out.push(v);
  }
  return out;
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new FormulaError(`Bad date: ${value}`);
    return d;
  }
  throw new FormulaError(`Cannot interpret ${String(value)} as date`);
}

const FUNCTIONS: Record<string, (args: unknown[]) => unknown> = {
  IF: (a) => (truthy(a[0]) ? a[1] : a[2] ?? null),
  IFS: (a) => {
    if (a.length % 2 !== 0) throw new FormulaError('IFS expects an even number of arguments.');
    for (let i = 0; i < a.length; i += 2) if (truthy(a[i])) return a[i + 1];
    return null;
  },
  AND: (a) => flatten(a).every(truthy),
  OR: (a) => flatten(a).some(truthy),
  NOT: (a) => !truthy(a[0]),
  SUM: (a) => flatten(a).filter((v) => v !== null && v !== undefined && v !== '').reduce<number>((s, v) => s + toNum(v), 0),
  AVG: (a) => {
    const nums = flatten(a).filter((v) => v !== null && v !== undefined && v !== '').map(toNum);
    return nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : 0;
  },
  AVERAGE: (a) => FUNCTIONS.AVG(a),
  MIN: (a) => {
    const nums = flatten(a).filter((v) => v !== null && v !== undefined && v !== '').map(toNum);
    if (!nums.length) throw new FormulaError('MIN of empty set');
    return Math.min(...nums);
  },
  MAX: (a) => {
    const nums = flatten(a).filter((v) => v !== null && v !== undefined && v !== '').map(toNum);
    if (!nums.length) throw new FormulaError('MAX of empty set');
    return Math.max(...nums);
  },
  COUNT: (a) => flatten(a).filter((v) => v !== null && v !== undefined && v !== '').length,
  ROUND: (a) => {
    const factor = Math.pow(10, a[1] === undefined ? 0 : Math.trunc(toNum(a[1])));
    return Math.round(toNum(a[0]) * factor) / factor;
  },
  CEIL: (a) => Math.ceil(toNum(a[0])),
  CEILING: (a) => Math.ceil(toNum(a[0])),
  FLOOR: (a) => Math.floor(toNum(a[0])),
  ABS: (a) => Math.abs(toNum(a[0])),
  COALESCE: (a) => {
    for (const v of a) if (v !== null && v !== undefined && v !== '') return v;
    return null;
  },
  IFNULL: (a) => FUNCTIONS.COALESCE(a),
  CONCAT: (a) => flatten(a).map((v) => (v == null ? '' : String(v))).join(''),
  CONCATENATE: (a) => FUNCTIONS.CONCAT(a),
  LEN: (a) => (a[0] == null ? 0 : String(a[0]).length),
  LEFT: (a) => {
    const s = a[0] == null ? '' : String(a[0]);
    return s.slice(0, Math.max(0, Math.trunc(toNum(a[1] ?? 1))));
  },
  RIGHT: (a) => {
    const s = a[0] == null ? '' : String(a[0]);
    const n = Math.max(0, Math.trunc(toNum(a[1] ?? 1)));
    return n ? s.slice(-n) : '';
  },
  MID: (a) => {
    const s = a[0] == null ? '' : String(a[0]);
    const start = Math.max(1, Math.trunc(toNum(a[1])));
    const n = Math.max(0, Math.trunc(toNum(a[2])));
    return s.slice(start - 1, start - 1 + n);
  },
  LOWER: (a) => (a[0] == null ? '' : String(a[0]).toLowerCase()),
  UPPER: (a) => (a[0] == null ? '' : String(a[0]).toUpperCase()),
  TRIM: (a) => (a[0] == null ? '' : String(a[0]).trim().replace(/\s+/g, ' ')),
  TODAY: () => new Date().toISOString().slice(0, 10),
  NOW: () => new Date().toISOString(),
  YEAR: (a) => toDate(a[0]).getFullYear(),
  MONTH: (a) => toDate(a[0]).getMonth() + 1,
  DAY: (a) => toDate(a[0]).getDate(),
  DATEDIF: (a) => {
    const start = toDate(a[0]);
    const end = toDate(a[1]);
    const unit = String(a[2] ?? 'D').toUpperCase().trim();
    if (unit === 'D') return Math.round((end.getTime() - start.getTime()) / 86_400_000);
    if (unit === 'M')
      return (
        (end.getFullYear() - start.getFullYear()) * 12 +
        (end.getMonth() - start.getMonth()) -
        (end.getDate() < start.getDate() ? 1 : 0)
      );
    if (unit === 'Y') {
      let years = end.getFullYear() - start.getFullYear();
      if (
        end.getMonth() < start.getMonth() ||
        (end.getMonth() === start.getMonth() && end.getDate() < start.getDate())
      ) years -= 1;
      return years;
    }
    throw new FormulaError('DATEDIF unit must be D/M/Y');
  },
  DATE_ADD: (a) => {
    const d = toDate(a[0]);
    d.setDate(d.getDate() + Math.trunc(toNum(a[1])));
    return d.toISOString().slice(0, 10);
  },
};

export function functionNames(): string[] {
  return Object.keys(FUNCTIONS).sort();
}

// ─── Compile + evaluate ───────────────────────────────────────────────────

export interface CompiledFormula {
  source: string;
  ast: Node;
  dependencies: string[];
  evaluate(row: Record<string, unknown>): unknown;
}

function collectDeps(node: Node, allowed: Set<string> | null, deps: Set<string>): void {
  switch (node.kind) {
    case 'ref':
      if (allowed && !allowed.has(node.name)) {
        throw new FormulaError(`Unknown column reference: ${node.name}`);
      }
      deps.add(node.name);
      return;
    case 'unary':
      collectDeps(node.operand, allowed, deps);
      return;
    case 'binary':
      collectDeps(node.left, allowed, deps);
      collectDeps(node.right, allowed, deps);
      return;
    case 'call':
      if (!FUNCTIONS[node.name]) throw new FormulaError(`Unknown function: ${node.name}`);
      for (const arg of node.args) collectDeps(arg, allowed, deps);
      return;
    default:
      return;
  }
}

function evalNode(node: Node, row: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'num': return node.value;
    case 'str': return node.value;
    case 'bool': return node.value;
    case 'null': return null;
    case 'ref': return row[node.name];
    case 'unary': {
      const v = evalNode(node.operand, row);
      if (node.op === '+') return toNum(v);
      if (node.op === '-') return -toNum(v);
      return !truthy(v);
    }
    case 'binary': {
      // Short-circuit logic.
      if (node.op === '&&') {
        const a = evalNode(node.left, row);
        if (!truthy(a)) return false;
        return truthy(evalNode(node.right, row));
      }
      if (node.op === '||') {
        const a = evalNode(node.left, row);
        if (truthy(a)) return true;
        return truthy(evalNode(node.right, row));
      }
      const left = evalNode(node.left, row);
      const right = evalNode(node.right, row);
      switch (node.op) {
        case '+':
          if (typeof left === 'string' || typeof right === 'string') {
            return (left == null ? '' : String(left)) + (right == null ? '' : String(right));
          }
          return toNum(left) + toNum(right);
        case '-': return toNum(left) - toNum(right);
        case '*': return toNum(left) * toNum(right);
        case '/': {
          const denom = toNum(right);
          if (denom === 0) throw new FormulaError('Division by zero');
          return toNum(left) / denom;
        }
        case '%': return toNum(left) % toNum(right);
        case '**': return Math.pow(toNum(left), toNum(right));
        case '==': return coerceEqual(left, right);
        case '!=': return !coerceEqual(left, right);
        case '<': return toNum(left) < toNum(right);
        case '<=': return toNum(left) <= toNum(right);
        case '>': return toNum(left) > toNum(right);
        case '>=': return toNum(left) >= toNum(right);
        default:
          throw new FormulaError(`Unknown operator: ${node.op}`);
      }
    }
    case 'call': {
      const fn = FUNCTIONS[node.name];
      const args = node.args.map((arg) => evalNode(arg, row));
      return fn(args);
    }
  }
}

function coerceEqual(a: unknown, b: unknown): boolean {
  if (a === null && b === '') return true;
  if (b === null && a === '') return true;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  return a === b;
}

export function compileFormula(
  source: string,
  options: { allowedColumns?: Iterable<string> } = {},
): CompiledFormula {
  if (!source.trim()) throw new FormulaError('Empty formula');
  const tokens = tokenize(source);
  const ast = new Parser(tokens).parse();
  const allowed = options.allowedColumns ? new Set([...options.allowedColumns]) : null;
  const deps = new Set<string>();
  collectDeps(ast, allowed, deps);
  return {
    source,
    ast,
    dependencies: [...deps],
    evaluate(row) {
      try {
        return evalNode(ast, row);
      } catch (err) {
        if (err instanceof FormulaError) throw err;
        throw new FormulaError(String(err));
      }
    },
  };
}

export function evaluateFormula(source: string, row: Record<string, unknown>): unknown {
  return compileFormula(source).evaluate(row);
}

// ─── Topological sort for inter-formula dependencies ──────────────────────

export function buildFormulaOrder(
  formulas: Record<string, CompiledFormula>,
  externalColumns: Iterable<string> = [],
): string[] {
  const names = new Set(Object.keys(formulas));
  const externals = new Set(externalColumns);
  const indegree: Record<string, number> = {};
  const downstream: Record<string, string[]> = {};
  for (const name of names) {
    indegree[name] = 0;
    downstream[name] = [];
  }
  for (const [name, formula] of Object.entries(formulas)) {
    for (const dep of formula.dependencies) {
      if (names.has(dep)) {
        downstream[dep].push(name);
        indegree[name] += 1;
      } else if (!externals.has(dep)) {
        throw new FormulaError(`Formula '${name}' references unknown column '${dep}'.`);
      }
    }
  }
  const queue: string[] = Object.keys(indegree).filter((n) => indegree[n] === 0);
  const order: string[] = [];
  while (queue.length) {
    queue.sort();
    const n = queue.shift()!;
    order.push(n);
    for (const next of downstream[n]) {
      indegree[next] -= 1;
      if (indegree[next] === 0) queue.push(next);
    }
  }
  if (order.length !== names.size) {
    const remaining = Object.entries(indegree)
      .filter(([, d]) => d > 0)
      .map(([n]) => n)
      .sort();
    throw new FormulaError(`Circular dependency: ${remaining.join(', ')}`);
  }
  return order;
}
