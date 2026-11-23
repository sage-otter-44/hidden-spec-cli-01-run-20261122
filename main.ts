// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements all of SPEC.md: the command line, the output
// and exit codes, safe paths, format detection, line matching at three tiers (section 5), unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write (section 10). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file split at its own line break (SPEC.md section 3). */
interface FileParts {
  br: string;
  lines: string[];
  final: boolean;
}
function splitFile(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}
function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { from: string; to: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Section 5: matching lines ----

/** A line of N: a context line is written as the file's own matched line, the rest as written (section 5). */
interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Start positions where O occurs in `lines` at one tier, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i++) {
    if (eofOnly && i + o.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (tier 0 only with --strict), or null. */
function matchAtTier(
  lines: string[],
  o: string[],
  strict: boolean,
  from = 0,
  eofOnly = false,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const p = occurrences(lines, o, t, from, eofOnly);
    if (p.length > 0) return { tier: t, positions: p };
  }
  return null;
}

/** The lines N writes when it replaces O at `pos`: context lines are the file's own, the rest are
 * re-indented at tier 2 (section 5). */
function buildN(fileLines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const f = leadingWs(fileLines[pos] ?? '');
  const p = leadingWs(o[0] ?? '');
  return n.map((nl) => {
    if (nl.ctx) return fileLines[pos + nl.oIdx]!;
    if (tier === 2) {
      const t = nl.text;
      if (t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) return f + t.slice(p.length);
    }
    return nl.text;
  });
}

// ---- Section 6: unified diffs ----

const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface UHunk {
  a: number;
  o: string[];
  n: NLine[];
  /** a `\` line follows the hunk's last context or `+` line */
  noEol: boolean;
  hasPlus: boolean;
  /** a `\` line follows the hunk's last `+` line */
  plusNoEol: boolean;
}

interface USection {
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

/** The path of a `--- ` / `+++ ` header line: after the four characters, up to the first tab,
 * surrounding spaces removed, a leading `a/` or `b/` removed, `/dev/null` meaning no file. */
function headerPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p === '/dev/null' ? null : p;
}

interface BodyLine {
  kind: string;
  text: string;
}

function parseUHunk(lines: string[], i: number): { hunk: UHunk; next: number } {
  const m = HUNK_RE.exec(lines[i]!);
  if (!m) throw new Exit2(`error: parse ${i + 1}`);
  const a = parseInt(m[1]!, 10);
  const n = lines.length;
  const body: BodyLine[] = [];
  let j = i + 1;
  while (j < n) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    const c = l[0] ?? '';
    if (c === ' ' || c === '-' || c === '+' || c === '\\') {
      body.push({ kind: c, text: l.slice(1) });
      j++;
      continue;
    }
    if (l === '') {
      body.push({ kind: '', text: '' });
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1]!.kind === '') body.pop();
  const o: string[] = [];
  const nl: NLine[] = [];
  for (const b of body) {
    if (b.kind === ' ' || b.kind === '') {
      o.push(b.text);
      nl.push({ text: b.text, ctx: true, oIdx: o.length - 1 });
    } else if (b.kind === '-') o.push(b.text);
    else if (b.kind === '+') nl.push({ text: b.text, ctx: false, oIdx: -1 });
  }
  let lastCtxPlus = -1;
  let lastPlus = -1;
  body.forEach((b, idx) => {
    if (b.kind === ' ' || b.kind === '' || b.kind === '+') lastCtxPlus = idx;
    if (b.kind === '+') lastPlus = idx;
  });
  const noEol = lastCtxPlus >= 0 && body[lastCtxPlus + 1]?.kind === '\\';
  const plusNoEol = lastPlus >= 0 && body[lastPlus + 1]?.kind === '\\';
  return { hunk: { a, o, n: nl, noEol, hasPlus: lastPlus >= 0, plusNoEol }, next: j };
}

/** Parse one section's header and hunks, starting at `start`; return the index of the next section's
 * first line, or the end of the patch. */
function parseUSection(lines: string[], start: number, sec: USection): number {
  const n = lines.length;
  let i = start;
  let inHeader = true;
  while (i < n) {
    const line = lines[i]!;
    if (inHeader) {
      if (line.startsWith('@@')) {
        const r = parseUHunk(lines, i);
        sec.hunks.push(r.hunk);
        i = r.next;
        inHeader = false;
        continue;
      }
      if (line.startsWith('diff --git ')) {
        if (!DIFF_GIT_RE.test(line)) throw new Exit2(`error: parse ${i + 1}`);
        break;
      }
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          sec.oldPath = headerPath(line.slice(4));
          sec.newPath = headerPath(lines[i + 1]!.slice(4));
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('+++ ')) {
        sec.newPath = headerPath(line.slice(4));
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        sec.renameFrom = line.slice(12).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renameTo = line.slice(10).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.delFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      if (!DIFF_GIT_RE.test(line)) throw new Exit2(`error: parse ${i + 1}`);
      break;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line.startsWith('@@')) {
      const r = parseUHunk(lines, i);
      sec.hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    i++;
  }
  return i;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const dm = DIFF_GIT_RE.exec(line);
      if (!dm) throw new Exit2(`error: parse ${i + 1}`);
      const sec: USection = {
        oldPath: undefined,
        newPath: undefined,
        renameFrom: undefined,
        renameTo: undefined,
        diffOld: dm[1]!,
        diffNew: dm[2]!,
        newFile: false,
        delFile: false,
        hunks: [],
      };
      i = parseUSection(lines, i + 1, sec);
      sections.push(sec);
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: USection = {
        oldPath: undefined,
        newPath: undefined,
        renameFrom: undefined,
        renameTo: undefined,
        diffOld: undefined,
        diffNew: undefined,
        newFile: false,
        delFile: false,
        hunks: [],
      };
      i = parseUSection(lines, i, sec);
      sections.push(sec);
      continue;
    }
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Apply a section's hunks in order to a file's text. */
function applyHunks(text: string, hunks: UHunk[], strict: boolean, path: string): string {
  const { br, lines, final: final0 } = splitFile(text);
  let final = final0;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = pos === lines.length;
      const add = h.n.map((x) => x.text);
      lines.splice(pos, 0, ...add);
      if (atEnd && add.length > 0) final = !h.noEol;
      d += add.length;
      continue;
    }
    const m = matchAtTier(lines, h.o, strict);
    if (!m) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = m.positions[0]!;
    let best = Math.abs(pos - target);
    for (const q of m.positions) {
      const dist = Math.abs(q - target);
      if (dist < best) {
        best = dist;
        pos = q;
      }
    }
    const atEnd = pos + h.o.length === lines.length;
    const out = buildN(lines, pos, h.o, h.n, m.tier);
    lines.splice(pos, h.o.length, ...out);
    if (atEnd) final = !h.noEol;
    d += out.length - h.o.length;
  }
  return joinFile(lines, br, final);
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath !== undefined ? sec.oldPath : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
    const newP = sec.newPath !== undefined ? sec.newPath : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
    const oldPath = oldP === undefined ? (newP ?? null) : oldP;
    const newPath = newP === undefined ? (oldP ?? null) : newP;
    const isCreate = oldPath === null || sec.newFile;
    if (isCreate) {
      const p = newPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastNoEol = false;
      for (const h of sec.hunks) {
        for (const x of h.n) if (!x.ctx) plus.push(x.text);
        if (h.hasPlus) lastNoEol = h.plusNoEol;
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (lastNoEol ? '' : '\n'));
      return;
    }
    const isDelete = newPath === null || sec.delFile;
    if (isDelete) {
      const p = oldPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldPath !== newPath) {
      const o = oldPath ?? '';
      const w = newPath ?? '';
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(w)) throw new Fail('unsafe', w);
      const before = tree.get(o);
      if (before === null) throw new Fail('missing', o);
      if (tree.get(w) !== null) throw new Fail('exists', w);
      const result = applyHunks(before, sec.hunks, strict, o);
      tree.now.set(o, null);
      tree.now.set(w, result);
      tree.moves.push({ from: o, to: w });
      return;
    }
    const p = oldPath ?? '';
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
  };
}

// ---- Section 7: SEARCH/REPLACE blocks ----

interface SRBlock {
  path: string;
  old: string[];
  new: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  let prevEnd = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i;
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (blocks.length > 0) path = blocks[blocks.length - 1]!.path;
        else throw new Exit2(`error: parse ${searchLine + 1}`);
      }
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
      blocks.push({ path, old: lines.slice(i + 1, eq), new: lines.slice(eq + 1, rep) });
      prevEnd = rep + 1;
      i = rep + 1;
    } else i++;
  }
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.new.length === 0 ? '' : b.new.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const { br, lines, final } = splitFile(before);
    const m = matchAtTier(lines, b.old, strict);
    if (!m) throw new Fail('no-match', b.path);
    if (m.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = m.positions[0]!;
    const out = buildN(
      lines,
      pos,
      b.old,
      b.new.map((t) => ({ text: t, ctx: false, oIdx: -1 })),
      m.tier,
    );
    lines.splice(pos, b.old.length, ...out);
    tree.now.set(b.path, joinFile(lines, br, final));
  };
}

// ---- Section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NLine[];
}

interface VSection {
  kind: 'add' | 'del' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
  line: number;
}

function isVSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

function vChunkLines(body: { kind: string; text: string }[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      o.push(b.text);
      n.push({ text: b.text, ctx: true, oIdx: o.length - 1 });
    } else if (b.kind === '-') o.push(b.text);
    else if (b.kind === '+') n.push({ text: b.text, ctx: false, oIdx: -1 });
  }
  return { o, n };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const sec: VSection = { kind: 'add', path, moveTo: null, addLines: [], chunks: [], line: i + 1 };
      let j = i + 1;
      const raw: { text: string; bl: boolean }[] = [];
      while (j < last) {
        const l = lines[j]!;
        if (isVSectionStart(l)) break;
        if (l.startsWith('+')) {
          raw.push({ text: l.slice(1), bl: false });
          j++;
          continue;
        }
        if (blank(l)) {
          raw.push({ text: '', bl: true });
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      while (raw.length > 0 && raw[raw.length - 1]!.bl) raw.pop();
      sec.addLines = raw.map((r) => r.text);
      sections.push(sec);
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      const sec: VSection = { kind: 'del', path, moveTo: null, addLines: [], chunks: [], line: i + 1 };
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (isVSectionStart(l)) break;
        if (blank(l)) {
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      sections.push(sec);
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const sec: VSection = { kind: 'update', path, moveTo: null, addLines: [], chunks: [], line: i + 1 };
      let j = i + 1;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        sec.moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j++;
      }
      let cur: { anchor: string | null; eof: boolean; body: { kind: string; text: string; raw: string }[] } | null = null;
      let seen = false;
      const pushCur = () => {
        if (cur) {
          const { o, n } = vChunkLines(cur.body);
          sec.chunks.push({ anchor: cur.anchor, eof: cur.eof, o, n });
          cur = null;
        }
      };
      while (j < last) {
        const l = lines[j]!;
        if (isVSectionStart(l)) break;
        if (l.startsWith('@@')) {
          pushCur();
          const anchorText = l.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
          seen = true;
          j++;
          continue;
        }
        if (l === '*** End of File') {
          if (!cur) throw new Exit2(`error: parse ${j + 1}`);
          cur.eof = true;
          pushCur();
          seen = true;
          j++;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (!cur) {
            if (seen) throw new Exit2(`error: parse ${j + 1}`);
            cur = { anchor: null, eof: false, body: [] };
            seen = true;
          }
          cur.body.push({ kind: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1), raw: l });
          j++;
          continue;
        }
        if (blank(l)) {
          if (cur) throw new Exit2(`error: parse ${j + 1}`);
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      if (cur) {
        while (cur.body.length > 0 && blank(cur.body[cur.body.length - 1]!.raw)) cur.body.pop();
        pushCur();
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      sections.push(sec);
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    if (sec.kind === 'add') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'del') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const { br, lines, final } = splitFile(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        let found = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let k = cursor; k < lines.length; k++) {
            if (lineEq(lines[k]!, chunk.anchor, t)) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', sec.path);
        cursor = found + 1;
      }
      if (chunk.o.length === 0) {
        const pos = chunk.eof ? lines.length : cursor;
        const add = chunk.n.map((x) => x.text);
        lines.splice(pos, 0, ...add);
        cursor = pos + add.length;
        continue;
      }
      const m = matchAtTier(lines, chunk.o, strict, cursor, chunk.eof);
      if (!m) throw new Fail('no-match', sec.path);
      const pos = m.positions[0];
      const out = buildN(lines, pos, chunk.o, chunk.n, m.tier);
      lines.splice(pos, chunk.o.length, ...out);
      cursor = pos + out.length;
    }
    const result = joinFile(lines, br, final);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, result);
      tree.moves.push({ from: sec.path, to: sec.moveTo });
    } else {
      tree.now.set(sec.path, result);
    }
  };
}

// ---- Section 1, 2 and 10: invocation, output, order and atomicity ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const display: { key: string; text: string }[] = [];
  const suppressed = new Set<string>();
  for (const mv of tree.moves) {
    const wasOld = tree.original(mv.from);
    const nowOld = tree.get(mv.from);
    const wasNew = tree.original(mv.to);
    const nowNew = tree.get(mv.to);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      display.push({ key: mv.to, text: `R ${mv.from} -> ${mv.to}` });
      suppressed.add(`D:${mv.from}`);
      suppressed.add(`A:${mv.to}`);
    }
  }
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    const kind = was === null ? 'A' : now === null ? 'D' : 'M';
    if (suppressed.has(`${kind}:${p}`)) continue;
    display.push({ key: p, text: `${kind} ${p}` });
  }
  display.sort((a, b) => byteCmp(a.key, b.key));
  const rows = display.map((d) => d.text);
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
