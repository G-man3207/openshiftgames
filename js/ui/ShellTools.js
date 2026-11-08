/**
 * ShellTools — the dependency-free simulated bash layer of the OpenShift Games
 * terminal (issue #11: "All YAML has to be written in the Files GUI").
 *
 * Real oc runs *inside* a shell, and the EX280 exam requires editing YAML with
 * `vim`, writing files with heredocs/echo redirects, and piping command output
 * through `grep`/`tail`/`head`/`wc`. The CommandBar owns the terminal + the
 * virtual filesystem bridge (ManifestEngine); this module owns the shell
 * commands themselves and the small amount of shell syntax the simulator
 * supports:
 *
 *   - heredocs:            cat <<EOF > manifests/app.yaml … EOF
 *   - command substitution:  oc create secret generic s --from-literal=password=$(openssl rand -hex 16)
 *   - pipelines/redirects:  handled by CommandBar's splitPipeline (this module
 *                           only executes a single stage, stdin → stdout)
 *   - grep context:          grep -A2/-A 2/-B/-C (real grep semantics, `--` group separators)
 *   - stream editing:        sed -n '1,40p', sed 's/foo/bar/[g]' (first occurrence per
 *                           line unless `g`; works in pipelines: `oc describe … | sed -n 1,40p`)
 *   - commands:            cat, echo, grep, tail, head, wc, vim/vi, sort, uniq,
 *                          cut (-c char ranges, -f fields), tr, sed, ls, rm, cp, mv,
 *                          touch, pwd, which, env, base64 (-d/-w0), curl (workstation
 *                          HTTP(S) to Routes; -s/-S, -o, -w, -i/-I, -k, -L; also
 *                          renders `oc exec … -- curl` via runExecCurl), openssl
 *                          (rand, req -x509, x509), skopeo, htpasswd (-B forwarded
 *                          to bcrypt hashing)
 *
 * The CommandBar calls `isShellLine()` to decide whether an input line is shell
 * (no `oc` prefix is added), `preprocess()` for heredocs/substitutions, and
 * `runTokens()` for each shell pipeline stage. File IO always goes through the
 * ManifestEngine-backed helpers on the CommandBar so terminal-created files are
 * immediately visible/editable in the Files panel and `oc apply -f`-able.
 *
 * Browser-only commands (`vim`, `clear`) degrade gracefully in Node imports:
 * this module never touches `document`/`window` at import time.
 */

import {
  LinuxHost,
  HOME as LINUX_HOME,
  errnoText,
  hasGlobChars,
  globToRegExp,
} from '../engine/LinuxHost.js';
import { LINUX_COMMANDS, LINUX_COMMAND_METHODS } from './LinuxCommands.js';

/** Shell commands recognised without the `oc ` prefix (completion + dispatch). */
export const SHELL_COMMANDS = [
  'cat',
  'echo',
  'base64',
  'grep',
  'tail',
  'head',
  'wc',
  'vim',
  'vi',
  'sort',
  'uniq',
  'cut',
  'tr',
  'sed',
  'ls',
  'rm',
  'cp',
  'mv',
  'touch',
  'pwd',
  'which',
  'env',
  'printenv',
  'export',
  'unset',
  'true',
  'false',
  'openssl',
  'curl',
  'skopeo',
  'htpasswd',
  'clear',
  'exit',
  // 1.16.0: the RHEL 9 workstation (js/engine/LinuxHost.js + js/ui/LinuxCommands.js).
  ...LINUX_COMMANDS,
];

/** Commands that take file paths (Tab completion / suggestion hints). */
export const SHELL_FILE_COMMANDS = new Set([
  'cat',
  'base64',
  'vim',
  'vi',
  'head',
  'tail',
  'wc',
  'grep',
  'sed',
  'rm',
  'source',
  'cd',
  'ls',
  'cp',
  'mv',
  'mkdir',
  'rmdir',
  'touch',
  'less',
  'more',
  'tee',
  'stat',
  'chmod',
  'chown',
  'chgrp',
  'tar',
  'file',
  'bash',
  'nano',
  'diff',
  'sort',
  'cut',
  'du',
  'find',
  'restorecon',
  'ln',
]);

const SHELL_COMMAND_SET = new Set(SHELL_COMMANDS);

/** Tiny shell tokenizer (quotes + escapes) — kept local to avoid a module cycle. */
export function tokenizeShell(input) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const ch of String(input ?? '')) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current !== '') tokens.push(current);
  return tokens;
}

/**
 * Index of the `)` that closes the `$(` starting at `dollarIndex`, honouring
 * nested parentheses and quotes inside the substitution (bash `$(…)` grammar).
 * @param {string} text
 * @param {number} dollarIndex index of the `$` character
 * @returns {number} index of the closing `)`, or -1 when unterminated
 */
export function findCommandSubstitutionEnd(text, dollarIndex) {
  let depth = 0;
  let quote = null;
  for (let index = dollarIndex + 1; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === '\\' && quote === '"' && index + 1 < text.length) {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Split a raw shell command line into `;` / `&&` / `||` segments (issue #50).
 *
 * The split is quote- and escape-aware, so operators inside quotes are plain
 * data; pipes and redirects stay inside one segment (the CommandBar's
 * splitPipeline() scopes them per segment). Newlines behave like `;`, so a
 * multi-line paste never silently runs only its first line.
 *
 * @param {string} input
 * @returns {{segments: string[], operators: Array<';'|'&&'|'||'>, error: string|null}}
 */
export function splitShellSegments(input) {
  const text = String(input ?? '');
  const segments = [];
  const operators = [];
  let current = '';
  let quote = null;
  let escaped = false;
  const flushSegment = () => {
    const segment = current.trim();
    current = '';
    return segment;
  };
  const syntaxError = (token, message) => ({
    segments,
    operators,
    error: message || `simulator: syntax error near unexpected token \`${token}'`,
  });
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      // Keep the backslash for the tokenizer, which unescapes the pair.
      current += `\\${ch}`;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '&' && text[i + 1] === '&') {
      const segment = flushSegment();
      if (!segment) return syntaxError('&&');
      segments.push(segment);
      operators.push('&&');
      i += 1;
      continue;
    }
    if (ch === '|' && text[i + 1] === '|') {
      const segment = flushSegment();
      if (!segment) return syntaxError('||');
      segments.push(segment);
      operators.push('||');
      i += 1;
      continue;
    }
    if (ch === '&') {
      // Single `&` would background the pipeline. The simulator runs
      // synchronously, so fail loudly instead of pretending (#50).
      return syntaxError(
        '&',
        'simulator: background jobs (&) are not supported — run one command per line'
      );
    }
    if (ch === ';' || ch === '\n') {
      const segment = flushSegment();
      // A leading/duplicate separator (`; echo`, `a;;b`) is a bash syntax error.
      if (!segment) return syntaxError(ch);
      segments.push(segment);
      operators.push(';');
      continue;
    }
    current += ch;
  }
  if (escaped) current += '\\';
  if (quote) {
    return syntaxError(quote, 'simulator: syntax error: unterminated quoted string');
  }
  const last = flushSegment();
  if (last) segments.push(last);
  if (operators.length >= segments.length) {
    const dangling = operators.pop();
    if (dangling !== ';') {
      return syntaxError(
        dangling,
        `simulator: syntax error: unexpected end of command line after \`${dangling}'`
      );
    }
  }
  return { segments, operators, error: null };
}

/**
 * Expand `$NAME` / `${NAME}` / `$?` / `${?}` in a shell word list, bash-style
 * (issues #50/#63). Single quotes protect the literal; double quotes and
 * unquoted words expand; a backslash escapes `$`; undefined variables expand to
 * the empty string. `$?` is the exit status of the last executed command (0
 * when the caller supplies no status). The replacement text is never re-parsed
 * for `;`/`&&` (bash expands after parsing), which is why the CommandBar calls
 * this per segment.
 * @param {string} text
 * @param {Record<string, string>} [env]
 * @returns {string}
 */
export function expandShellVariables(text, env = {}) {
  const source = String(text ?? '');
  const lookup = (name) =>
    Object.prototype.hasOwnProperty.call(env, name) ? String(env[name] ?? '') : '';
  /** bash's `$?`: the last command's exit status, 0 for a fresh shell. */
  const lastStatus = () =>
    Object.prototype.hasOwnProperty.call(env, '?') ? String(env['?'] ?? '') : '0';
  // `$NAME` / `${NAME}` / `$?` / `${?}` at position `start` (source[start] === '$').
  const expansionAt = (start) => {
    if (source[start + 1] === '?') return { value: lastStatus(), end: start + 2 };
    // Script positional/special parameters (`$1`, `$#`, `$@`, `$$`) when the caller defines
    // them (scripts run by `bash`/`source`, 1.16.0); otherwise left literal as before.
    const special = source[start + 1];
    if (
      special !== undefined &&
      /[0-9#@*$]/.test(special) &&
      Object.prototype.hasOwnProperty.call(env, special)
    ) {
      return { value: lookup(special), end: start + 2 };
    }
    if (source[start + 1] === '{') {
      const close = source.indexOf('}', start + 2);
      if (close < 0) return null;
      const name = source.slice(start + 2, close);
      if (name === '?') return { value: lastStatus(), end: close + 1 };
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
      return { value: lookup(name), end: close + 1 };
    }
    const match = source.slice(start + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (!match) return null;
    return { value: lookup(match[0]), end: start + 1 + match[0].length };
  };
  let result = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'") {
      const close = source.indexOf("'", i + 1);
      if (close < 0) return result + source.slice(i);
      result += source.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      result += ch;
      i += 1;
      while (i < source.length) {
        const inner = source[i];
        if (inner === '\\' && i + 1 < source.length) {
          result += inner + source[i + 1];
          i += 2;
          continue;
        }
        if (inner === '"') {
          result += inner;
          i += 1;
          break;
        }
        if (inner === '$') {
          const expansion = expansionAt(i);
          if (expansion) {
            result += expansion.value;
            i = expansion.end;
            continue;
          }
        }
        result += inner;
        i += 1;
      }
      continue;
    }
    if (ch === '\\' && i + 1 < source.length) {
      result += ch + source[i + 1];
      i += 2;
      continue;
    }
    if (ch === '$') {
      const expansion = expansionAt(i);
      if (expansion) {
        result += expansion.value;
        i = expansion.end;
        continue;
      }
    }
    result += ch;
    i += 1;
  }
  return result;
}

/**
 * Detect bash constructs the simulator does not model and return a clear error
 * (#50). Callers must check this for the whole line BEFORE running any segment,
 * so an unsupported loop/conditional never executes part of the line.
 * @param {string[]} segments
 * @returns {string|null}
 */
export function findUnsupportedShellSyntax(segments) {
  const loops = new Set(['for', 'while', 'until', 'do', 'done', 'select']);
  const conditionals = new Set(['if', 'then', 'elif', 'else', 'fi', 'case', 'esac']);
  const functions = new Set(['function', '{', '(', '}']);
  for (const segment of segments || []) {
    const tokens = tokenizeShell(segment);
    if (!tokens.length) continue;
    const first = tokens[0].toLowerCase();
    if (loops.has(first)) {
      return 'simulator: shell loops are not supported — run one command per line';
    }
    if (conditionals.has(first)) {
      return 'simulator: shell conditionals are not supported — run one command per line';
    }
    if (functions.has(first)) {
      return 'simulator: shell functions are not supported — run one command per line';
    }
    // `foo() { …; }` / `foo () { … }` function definitions.
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(first) && (tokens[1] === '()' || tokens[1] === '(')) {
      return 'simulator: shell functions are not supported — run one command per line';
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*\(\)$/.test(first)) {
      return 'simulator: shell functions are not supported — run one command per line';
    }
  }
  return null;
}

function countWords(text) {
  return String(text || '')
    .split(/\s+/)
    .filter(Boolean).length;
}

/**
 * Parse a minimal `sed` script into executable commands (issue #26).
 *
 * Supported forms (the ones EX280 learners actually use):
 *   - `A,Bp` / `Ap` / `$p` / `p`  → print addressed lines (`-n` suppresses the
 *     implicit print of every other line),
 *   - `A,Bd` / `Ad` / `d`          → delete addressed lines,
 *   - `s/foo/bar/`, `s|foo|bar|g`  → substitute (first occurrence unless `g`).
 *
 * Anything else throws so the terminal reports a real-looking `sed` error
 * instead of silently doing the wrong thing.
 * @param {string} script
 * @returns {Array<{type:'print'|'delete'|'substitute', address?:{from?:number,to?:number,last?:boolean}, regex?:RegExp, replacement?:string, global?:boolean, printAfter?:boolean}>}
 */
function parseSedScript(script) {
  const text = String(script ?? '');
  if (!text.trim()) throw new Error('no script specified');
  const commands = [];
  for (const rawCommand of text.split(/[;\n]/)) {
    let command = rawCommand.trim();
    if (!command) continue;
    let address = null;
    let match = command.match(/^\/((?:\\.|[^/\\])*)\/([\s\S]*)$/);
    if (match) {
      // `/regex/` address (`sed '/api.cluster/d'`, 1.16.0).
      const source = match[1].replace(/\\\//g, '/');
      try {
        address = { regex: new RegExp(source) };
      } catch {
        address = { regex: new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) };
      }
      command = match[2];
    } else if ((match = command.match(/^(\d+),(\d+)([\s\S]*)$/))) {
      address = { from: Number(match[1]), to: Number(match[2]) };
      command = match[3];
    } else if ((match = command.match(/^(\d+)([\s\S]*)$/))) {
      address = { from: Number(match[1]), to: Number(match[1]) };
      command = match[2];
    } else if (command.startsWith('$')) {
      address = { last: true };
      command = command.slice(1);
    }
    command = command.trim();
    if (!command) throw new Error(`missing command in script "${rawCommand.trim()}"`);
    const operation = command[0];
    if (operation === 'p' && command.length === 1) {
      commands.push({ type: 'print', address });
      continue;
    }
    if (operation === 'd' && command.length === 1) {
      commands.push({ type: 'delete', address });
      continue;
    }
    if (operation === 's') {
      const delimiter = command[1];
      if (!delimiter || /[A-Za-z0-9\\]/.test(delimiter)) {
        throw new Error('unterminated `s` command');
      }
      const fields = [];
      let current = '';
      let index = 2;
      while (index < command.length) {
        const char = command[index];
        if (char === '\\' && index + 1 < command.length) {
          current += char + command[index + 1];
          index += 2;
          continue;
        }
        if (char === delimiter) {
          fields.push(current);
          current = '';
          index += 1;
          if (fields.length === 2) break;
          continue;
        }
        current += char;
        index += 1;
      }
      if (fields.length < 2) throw new Error('unterminated `s` command');
      const flagsText = command.slice(index);
      const patternSource = fields[0];
      const replacement = fields[1];
      let regex;
      try {
        regex = new RegExp(patternSource, flagsText.includes('i') ? 'i' : '');
      } catch {
        regex = new RegExp(
          patternSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          flagsText.includes('i') ? 'i' : ''
        );
      }
      commands.push({
        type: 'substitute',
        address,
        regex,
        replacement,
        global: flagsText.includes('g'),
        printAfter: flagsText.includes('p'),
      });
      continue;
    }
    throw new Error(
      `unsupported command "${command}" (simulator supports: sed -n 'A,Bp', sed 's/foo/bar/')`
    );
  }
  if (!commands.length) throw new Error('no script specified');
  return commands;
}

/** Build the JS replacement string for a sed `s///` replacement (`&`, `\1`). */
function sedReplacementString(replacement) {
  let output = '';
  for (let index = 0; index < replacement.length; index += 1) {
    const char = replacement[index];
    if (char === '\\' && index + 1 < replacement.length) {
      const next = replacement[index + 1];
      if (/[1-9]/.test(next)) {
        output += `$${next}`;
        index += 1;
        continue;
      }
      if (next === '&') {
        output += '&';
        index += 1;
        continue;
      }
      output += `\\${next}`;
      index += 1;
      continue;
    }
    if (char === '&') {
      output += '$&';
      continue;
    }
    if (char === '$') {
      output += '$$';
      continue;
    }
    output += char;
  }
  return output;
}

/** GNU sed -i temp-file suffix (6 chars, deterministic per path). */
function fakeTempSuffix(path) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let hash = fnv1aUint(path);
  let out = '';
  for (let index = 0; index < 6; index += 1) {
    out += alphabet[hash % alphabet.length];
    hash = Math.floor(hash / alphabet.length) + 7919 * (index + 1);
  }
  return out;
}

function sedAddressMatches(address, lineNumber, totalLines, line = '') {
  if (!address) return true;
  if (address.regex) return address.regex.test(line);
  if (address.last) return lineNumber === totalLines;
  const from = address.from ?? 1;
  const to = address.to ?? from;
  return lineNumber >= from && lineNumber <= to;
}

// ────────────────────────────────────────────────────────────────────────────
// PEM / X.509 simulation (issue #32b, reused by the service-ca controller #33a)
// ────────────────────────────────────────────────────────────────────────────
//
// `openssl req -x509` must write real-looking PEM files into the virtual
// filesystem: `oc create secret tls` reads them, `oc get secret -o yaml` /
// `oc extract` round-trips them, and `openssl x509` parses them back. A small
// dependency-free DER encoder/parser is enough — the certificate bytes are
// structurally valid X.509 (external openssl parses this output), while the
// RSA modulus/signature are simulated stand-ins: the game never verifies
// crypto, it only teaches the workflow.
//
// The service-ca controller in SimulationTick reuses these helpers to issue
// serving certificates signed by the simulated cluster service CA.

/** FNV-1a 32-bit hash (deterministic seed material). */
function fnv1aUint(value) {
  let hash = 0x811c9dc5;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Deterministic pseudo-random bytes from a seed (xorshift32). */
function prngBytes(seed, length) {
  const out = [];
  let state = fnv1aUint(seed) || 0x9e3779b9;
  while (out.length < length) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out.push(state & 0xff, (state >>> 8) & 0xff, (state >>> 16) & 0xff, (state >>> 24) & 0xff);
  }
  return out.slice(0, length);
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index] & 0xff);
  }
  if (typeof btoa === 'function') return btoa(binary);
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  return binary;
}

function base64ToBytes(text) {
  const clean = String(text ?? '').replace(/\s+/g, '');
  if (!clean) return [];
  if (typeof atob === 'function') {
    const binary = atob(clean);
    const bytes = [];
    for (let index = 0; index < binary.length; index += 1) bytes.push(binary.charCodeAt(index));
    return bytes;
  }
  if (typeof Buffer !== 'undefined') return Array.from(Buffer.from(clean, 'base64'));
  return [];
}

function textToUtf8Bytes(text) {
  if (typeof TextEncoder === 'function') return Array.from(new TextEncoder().encode(String(text)));
  const encoded = unescape(encodeURIComponent(String(text)));
  const bytes = [];
  for (let index = 0; index < encoded.length; index += 1) bytes.push(encoded.charCodeAt(index));
  return bytes;
}

function utf8BytesToText(bytes) {
  if (typeof TextDecoder === 'function') {
    try {
      return new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
    } catch {
      /* fall through */
    }
  }
  return bytes.map((byte) => String.fromCharCode(byte)).join('');
}

function bytesToHex(bytes, separator = '') {
  return bytes.map((byte) => Number(byte).toString(16).padStart(2, '0')).join(separator);
}

// ── DER encoder ─────────────────────────────────────────────────────────────

function derLengthBytes(length) {
  if (length < 0x80) return [length];
  const bytes = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function derTlv(tag, content) {
  return [tag, ...derLengthBytes(content.length), ...content];
}

function derFlatten(parts) {
  const out = [];
  for (const part of parts) out.push(...part);
  return out;
}

function derSequence(...parts) {
  return derTlv(0x30, derFlatten(parts));
}

function derSet(...parts) {
  return derTlv(0x31, derFlatten(parts));
}

function derInteger(bytes) {
  let trimmed = [...bytes];
  while (trimmed.length > 1 && trimmed[0] === 0) trimmed.shift();
  if (trimmed.length === 0) trimmed = [0];
  if (trimmed[0] & 0x80) trimmed.unshift(0x00);
  return derTlv(0x02, trimmed);
}

function derOid(oidBytes) {
  return derTlv(0x06, oidBytes);
}

function derNull() {
  return [0x05, 0x00];
}

function derBoolean(value) {
  return [0x01, 0x01, value ? 0xff : 0x00];
}

function derUtf8String(text) {
  return derTlv(0x0c, textToUtf8Bytes(text));
}

function derOctetString(bytes) {
  return derTlv(0x04, bytes);
}

function derBitString(payload, unusedBits = 0) {
  return derTlv(0x03, [unusedBits, ...payload]);
}

function derExplicit(tagNumber, content) {
  return derTlv(0xa0 | tagNumber, content);
}

function utcTimeDer(date) {
  const year = date.getUTCFullYear();
  const pad = (value) => String(value).padStart(2, '0');
  const base =
    `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  if (year >= 1950 && year < 2050)
    return derTlv(0x17, textToUtf8Bytes(`${pad(year % 100)}${base}`));
  return derTlv(0x18, textToUtf8Bytes(`${year}${base}`));
}

const OID = {
  rsaEncryption: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01],
  sha256WithRsa: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b],
  commonName: [0x55, 0x04, 0x03],
  organization: [0x55, 0x04, 0x0a],
  organizationalUnit: [0x55, 0x04, 0x0b],
  country: [0x55, 0x04, 0x06],
  state: [0x55, 0x04, 0x08],
  locality: [0x55, 0x04, 0x07],
  subjectAltName: [0x55, 0x1d, 0x11],
  basicConstraints: [0x55, 0x1d, 0x13],
};
const OID_KEY_TO_NAME = new Map(
  Object.entries(OID).map(([name, bytes]) => [bytesToHex(bytes), name])
);
const NAME_FIELD_BY_OID = {
  commonName: 'commonName',
  organization: 'organization',
  organizationalUnit: 'organizationalUnit',
  country: 'country',
  state: 'state',
  locality: 'locality',
};

function oidShortName(bytes) {
  return OID_KEY_TO_NAME.get(bytesToHex(bytes)) || `OID.${bytes.join('.')}`;
}

function buildDistinguishedName(attributes) {
  const rdns = [];
  for (const [field, value] of Object.entries(attributes)) {
    const oid = OID[field];
    if (!oid || value === undefined || value === null || value === '') continue;
    rdns.push(derSet(derSequence(derOid(oid), derUtf8String(String(value)))));
  }
  return derSequence(...rdns);
}

function generateRsaKeyMaterial(bits = 2048) {
  const byteLength = Math.ceil(bits / 8);
  const seed = `${Date.now()}-${Math.random()}-${Math.random()}`;
  const modulus = prngBytes(`${seed}-n`, byteLength);
  modulus[0] = (modulus[0] & 0x7f) | 0x80;
  modulus[modulus.length - 1] |= 0x01;
  const randomOfLength = (label, length) => prngBytes(`${seed}-${label}`, length);
  return {
    bits: byteLength * 8,
    modulus,
    exponent: [0x01, 0x00, 0x01], // 65537
    private: {
      d: randomOfLength('d', byteLength),
      p: randomOfLength('p', Math.ceil(byteLength / 2)),
      q: randomOfLength('q', Math.ceil(byteLength / 2)),
      dp: randomOfLength('dp', Math.ceil(byteLength / 2)),
      dq: randomOfLength('dq', Math.ceil(byteLength / 2)),
      qInv: randomOfLength('qInv', Math.ceil(byteLength / 2)),
    },
    seed,
  };
}

function buildSubjectPublicKeyInfoDer(keyMaterial) {
  const algorithm = derSequence(derOid(OID.rsaEncryption), derNull());
  const rsaPublicKey = derSequence(
    derInteger(keyMaterial.modulus),
    derInteger(keyMaterial.exponent)
  );
  return derSequence(algorithm, derBitString(rsaPublicKey, 0));
}

function buildPrivateKeyPem(keyMaterial) {
  const rsaPrivateKey = derSequence(
    derInteger([0x00]),
    derInteger(keyMaterial.modulus),
    derInteger(keyMaterial.exponent),
    derInteger(keyMaterial.private.d),
    derInteger(keyMaterial.private.p),
    derInteger(keyMaterial.private.q),
    derInteger(keyMaterial.private.dp),
    derInteger(keyMaterial.private.dq),
    derInteger(keyMaterial.private.qInv)
  );
  const privateKeyInfo = derSequence(
    derInteger([0x00]),
    derSequence(derOid(OID.rsaEncryption), derNull()),
    derOctetString(rsaPrivateKey)
  );
  return toPemText('PRIVATE KEY', privateKeyInfo);
}

function toPemText(label, derBytes) {
  const base64 = bytesToBase64(derBytes);
  const lines = [];
  for (let index = 0; index < base64.length; index += 64)
    lines.push(base64.slice(index, index + 64));
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function pemToDer(pem, label) {
  const match = String(pem ?? '').match(
    new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`)
  );
  if (!match) return null;
  try {
    return base64ToBytes(match[1]);
  } catch {
    return null;
  }
}

function subjectAltNameExtension(sans = {}) {
  const names = [];
  for (const dns of sans.dns || []) names.push(derTlv(0x82, textToUtf8Bytes(dns)));
  for (const ip of sans.ip || []) {
    const parts = String(ip).split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) continue;
    names.push(derTlv(0x87, parts));
  }
  if (names.length === 0) return null;
  return derSequence(derOid(OID.subjectAltName), derOctetString(derSequence(...names)));
}

function basicConstraintsExtension() {
  return derSequence(
    derOid(OID.basicConstraints),
    derBoolean(true),
    derOctetString(derSequence(derBoolean(true), derInteger([0x00])))
  );
}

/** Monotonic positive certificate serial bytes. */
let serialCounter = 0;
function nextSerialBytes(seed) {
  serialCounter += 1;
  const bytes = prngBytes(`${seed ?? ''}-${Date.now()}-${serialCounter}`, 12);
  bytes[0] &= 0x7f;
  if (bytes[0] === 0) bytes[0] = 0x01;
  return bytes;
}

function parseSubjectString(subject) {
  const attributes = {};
  const fieldForShort = {
    CN: 'commonName',
    O: 'organization',
    OU: 'organizationalUnit',
    C: 'country',
    ST: 'state',
    L: 'locality',
  };
  for (const segment of String(subject ?? '').split('/')) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const short = trimmed.slice(0, eq).toUpperCase();
    const value = trimmed.slice(eq + 1);
    const field = fieldForShort[short];
    if (field && value) attributes[field] = value;
  }
  return attributes;
}

/**
 * Build a simulated X.509 certificate + PKCS#8 private key.
 * `organization: null` (and `null` for any RDN) omits that attribute; when the
 * option is `undefined` the simulator's branded `O = OpenShift Games` default
 * still applies (issue #43: `openssl req` leaf subjects must match `-subj`).
 * @param {{commonName?: string, organization?: string|null,
 *   organizationalUnit?: string, country?: string, state?: string, locality?: string,
 *   days?: number, issuer?: {commonName?: string, organization?: string},
 *   sans?: {dns?: string[], ip?: string[]}, isCA?: boolean, bits?: number,
 *   notBefore?: string|number, notAfter?: string|number}} options
 * @returns {{certPem: string, keyPem: string, der: number[], keyMaterial: object}}
 */
export function createCertificateMaterial(options = {}) {
  const commonName = String(options.commonName || options.subject || 'localhost');
  const organization =
    options.organization === undefined ? 'OpenShift Games' : options.organization;
  const days = Number.isFinite(Number(options.days)) ? Math.max(1, Number(options.days)) : 365;
  const now = options.notBefore ? new Date(options.notBefore) : new Date();
  const notAfter = options.notAfter
    ? new Date(options.notAfter)
    : new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const subjectAttributes = { commonName };
  // A `null` organization explicitly disables the simulator's default O= while
  // `undefined` keeps the branded default (issue #43: a leaf created by
  // `openssl req -x509 -subj "/CN=…"` must not gain `O = OpenShift Games`).
  if (organization !== null && organization !== undefined && organization !== '') {
    subjectAttributes.organization = organization;
  }
  for (const field of ['organizationalUnit', 'country', 'state', 'locality']) {
    const value = options[field];
    if (value !== null && value !== undefined && value !== '')
      subjectAttributes[field] = String(value);
  }
  const issuerAttributes = options.issuer
    ? {
        commonName: options.issuer.commonName || 'service-ca',
        organization: options.issuer.organization,
      }
    : subjectAttributes;
  const keyMaterial = generateRsaKeyMaterial(Number(options.bits) || 2048);
  const signatureAlgorithm = derSequence(derOid(OID.sha256WithRsa), derNull());
  const tbsParts = [
    derExplicit(0, derInteger([0x02])), // v3
    derInteger(nextSerialBytes(keyMaterial.seed)),
    signatureAlgorithm,
    buildDistinguishedName(issuerAttributes),
    derSequence(utcTimeDer(now), utcTimeDer(notAfter)),
    buildDistinguishedName(subjectAttributes),
    buildSubjectPublicKeyInfoDer(keyMaterial),
  ];
  const extensions = [];
  const san = subjectAltNameExtension(
    options.sans || { dns: commonName.includes('.') ? [commonName] : [] }
  );
  if (san) extensions.push(san);
  if (options.isCA) extensions.push(basicConstraintsExtension());
  if (extensions.length) tbsParts.push(derExplicit(3, derSequence(...extensions)));
  const tbs = derSequence(...tbsParts);
  // Simulated RSA signature (256 bytes for a 2048-bit key): structurally valid
  // DER either way, but the game never performs cryptographic verification.
  const signature = prngBytes(`sign:${bytesToHex(tbs)}:${keyMaterial.seed}`, 256);
  const certificate = derSequence(tbs, signatureAlgorithm, derBitString(signature, 0));
  return {
    certPem: toPemText('CERTIFICATE', certificate),
    keyPem: buildPrivateKeyPem(keyMaterial),
    der: certificate,
    keyMaterial,
  };
}

/** Self-signed certificate for `openssl req -x509`. */
export function createSelfSignedCertificate(options = {}) {
  const material = createCertificateMaterial(options);
  return { ...material, info: parseCertificatePem(material.certPem), subject: options.subject };
}

/** Certificate issued by the simulated cluster service CA (service-ca #33a). */
export function createServiceSignedCertificate(options = {}) {
  const commonName = String(options.commonName || 'service');
  const dnsNames = [commonName, ...(options.dnsNames || []).filter(Boolean)];
  const material = createCertificateMaterial({
    commonName,
    organization: 'OpenShift Games',
    days: options.days || 365,
    issuer: options.issuer || { commonName: 'service-ca', organization: 'OpenShift' },
    sans: { dns: dnsNames },
  });
  return { ...material, info: parseCertificatePem(material.certPem) };
}

/** The simulated cluster service CA (`service-ca` in `openshift-service-ca`). */
export function createCertificateAuthority(options = {}) {
  const commonName = String(options.commonName || 'service-ca');
  const material = createCertificateMaterial({
    commonName,
    organization: options.organization || 'OpenShift',
    days: options.days || 3650,
    isCA: true,
  });
  return {
    ...material,
    info: parseCertificatePem(material.certPem),
    subject: { commonName, organization: options.organization || 'OpenShift' },
  };
}

// ── DER parser: read certificates back like `openssl x509` ──────────────────

function derRead(bytes, offset) {
  const tag = bytes[offset];
  if (tag === undefined) return null;
  let length = bytes[offset + 1];
  if (length === undefined) return null;
  let header = 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let index = 0; index < count; index += 1) {
      length = (length << 8) | bytes[offset + 2 + index];
    }
    header = 2 + count;
  }
  const start = offset + header;
  return { tag, length, start, end: start + length, next: start + length };
}

function derChildren(bytes, node) {
  const children = [];
  let offset = node.start;
  while (offset < node.end) {
    const child = derRead(bytes, offset);
    if (!child || child.length < 0) break;
    children.push(child);
    offset = child.next;
  }
  return children;
}

function derContent(bytes, node) {
  return bytes.slice(node.start, node.end);
}

function readDerTime(bytes, node) {
  const text = utf8BytesToText(derContent(bytes, node));
  if (node.tag === 0x17 && text.length >= 12) {
    const shortYear = Number(text.slice(0, 2));
    const year = shortYear >= 50 ? 1900 + shortYear : 2000 + shortYear;
    return new Date(
      Date.UTC(
        year,
        Number(text.slice(2, 4)) - 1,
        Number(text.slice(4, 6)),
        Number(text.slice(6, 8)),
        Number(text.slice(8, 10)),
        Number(text.slice(10, 12))
      )
    );
  }
  if (node.tag === 0x18 && text.length >= 14) {
    return new Date(
      Date.UTC(
        Number(text.slice(0, 4)),
        Number(text.slice(4, 6)) - 1,
        Number(text.slice(6, 8)),
        Number(text.slice(8, 10)),
        Number(text.slice(10, 12)),
        Number(text.slice(12, 14))
      )
    );
  }
  return null;
}

function readDerName(bytes, node) {
  const attributes = {};
  for (const set of derChildren(bytes, node)) {
    for (const sequence of derChildren(bytes, set)) {
      const [oidNode, valueNode] = derChildren(bytes, sequence);
      if (!oidNode || !valueNode) continue;
      const field = NAME_FIELD_BY_OID[oidShortName(derContent(bytes, oidNode))];
      if (!field) continue;
      attributes[field] =
        valueNode.tag === 0x0c || valueNode.tag === 0x13 || valueNode.tag === 0x16
          ? utf8BytesToText(derContent(bytes, valueNode))
          : bytesToHex(derContent(bytes, valueNode));
    }
  }
  return attributes;
}

function readDerExtensions(bytes, node) {
  const result = { sans: [], isCA: false };
  if (!node) return result;
  for (const extension of derChildren(bytes, node)) {
    const parts = derChildren(bytes, extension);
    if (!parts.length) continue;
    const name = oidShortName(derContent(bytes, parts[0]));
    const valueNode = parts[parts.length - 1];
    if (!valueNode) continue;
    const inner = derRead(bytes, valueNode.start);
    if (!inner) continue;
    if (name === 'subjectAltName') {
      for (const generalName of derChildren(bytes, inner)) {
        if (generalName.tag === 0x82) {
          result.sans.push(utf8BytesToText(derContent(bytes, generalName)));
        } else if (generalName.tag === 0x87) {
          const ipParts = derContent(bytes, generalName);
          if (ipParts.length === 4) result.sans.push(ipParts.join('.'));
        }
      }
    } else if (name === 'basicConstraints') {
      const children = derChildren(bytes, inner);
      if (children[0] && children[0].tag === 0x01) {
        const bool = derContent(bytes, children[0]);
        result.isCA = bool.length > 0 && bool[0] !== 0;
      }
    }
  }
  return result;
}

/**
 * Parse a PEM certificate (as generated above, or any parseable X.509).
 * @param {string} pem
 * @returns {null|{subject: object, issuer: object, commonName: string,
 *   issuerCommonName: string, notBefore: Date|null, notAfter: Date|null,
 *   serial: string, signatureAlgorithm: string, version: number, publicKeyBits: number,
 *   modulus: number[], exponent: number, signatureBytes: number[], sans: string[],
 *   isCA: boolean}}
 */
export function parseCertificatePem(pem) {
  const der = pemToDer(pem, 'CERTIFICATE');
  if (!der || !der.length) return null;
  try {
    const certificate = derRead(der, 0);
    if (!certificate || certificate.tag !== 0x30) return null;
    const certificateChildren = derChildren(der, certificate);
    const [tbsNode, algorithmNode, signatureValueNode] = certificateChildren;
    if (!tbsNode || tbsNode.tag !== 0x30) return null;
    const tbsChildren = derChildren(der, tbsNode);
    let index = 0;
    let version = 1;
    if (tbsChildren[index] && tbsChildren[index].tag === 0xa0) {
      const versionInner = derChildren(der, tbsChildren[index])[0];
      if (versionInner) {
        version = Number.parseInt(bytesToHex(derContent(der, versionInner)), 16) + 1;
      }
      index += 1;
    }
    const serialNode = tbsChildren[index++];
    const signatureAlgNode = tbsChildren[index++];
    const issuerNode = tbsChildren[index++];
    const validityNode = tbsChildren[index++];
    const subjectNode = tbsChildren[index++];
    const spkiNode = tbsChildren[index++];
    let extensionsNode = null;
    for (const child of tbsChildren.slice(index)) {
      if (child.tag === 0xa3) extensionsNode = child;
    }
    let signatureAlgorithm = 'unknown';
    if (signatureAlgNode) {
      const oidNode = derChildren(der, signatureAlgNode)[0];
      if (oidNode) {
        const shortName = oidShortName(derContent(der, oidNode));
        signatureAlgorithm = shortName === 'sha256WithRsa' ? 'sha256WithRSAEncryption' : shortName;
      }
    }
    let publicKeyBits = 0;
    let modulus = [];
    let exponent = 0;
    if (spkiNode) {
      const spkiChildren = derChildren(der, spkiNode);
      const bitString = spkiChildren[1];
      if (bitString && bitString.tag === 0x03) {
        const rsaKey = derRead(der, bitString.start + 1);
        if (rsaKey) {
          const rsaChildren = derChildren(der, rsaKey);
          const modulusNode = rsaChildren[0];
          const exponentNode = rsaChildren[1];
          if (modulusNode && modulusNode.tag === 0x02) {
            let modulusBytes = derContent(der, modulusNode);
            if (modulusBytes[0] === 0) modulusBytes = modulusBytes.slice(1);
            modulus = modulusBytes;
            publicKeyBits = modulusBytes.length * 8;
          }
          if (exponentNode) {
            exponent = Number.parseInt(bytesToHex(derContent(der, exponentNode)), 16);
          }
        }
      }
    }
    const validityChildren = validityNode ? derChildren(der, validityNode) : [];
    const extensions = extensionsNode
      ? readDerExtensions(der, derChildren(der, extensionsNode)[0] || { start: 0, end: 0 })
      : { sans: [], isCA: false };
    const subject = subjectNode ? readDerName(der, subjectNode) : {};
    const issuer = issuerNode ? readDerName(der, issuerNode) : {};
    let signatureBytes = [];
    if (signatureValueNode && signatureValueNode.tag === 0x03) {
      signatureBytes = derContent(der, signatureValueNode).slice(1);
    }
    void algorithmNode;
    return {
      subject,
      issuer,
      commonName: subject.commonName || '',
      issuerCommonName: issuer.commonName || '',
      notBefore: validityChildren[0] ? readDerTime(der, validityChildren[0]) : null,
      notAfter: validityChildren[1] ? readDerTime(der, validityChildren[1]) : null,
      serial: serialNode ? bytesToHex(derContent(der, serialNode), ':') : '',
      signatureAlgorithm,
      version,
      publicKeyBits,
      modulus,
      exponent,
      signatureBytes,
      sans: extensions.sans,
      isCA: extensions.isCA,
    };
  } catch {
    return null;
  }
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** openssl-style date: `Nov  4 20:03:30 2026 GMT`. */
export function formatCertificateDate(date) {
  if (!date || Number.isNaN(date.getTime())) return 'invalid date';
  const pad = (value) => String(value).padStart(2, '0');
  return `${MONTH_NAMES[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, ' ')} ${pad(
    date.getUTCHours()
  )}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} ${date.getUTCFullYear()} GMT`;
}

/** openssl-style distinguished name: `CN = web.apps.example.com, O = OpenShift`. */
export function formatDistinguishedName(name) {
  const parts = [];
  if (name?.country) parts.push(`C = ${name.country}`);
  if (name?.state) parts.push(`ST = ${name.state}`);
  if (name?.locality) parts.push(`L = ${name.locality}`);
  if (name?.organization) parts.push(`O = ${name.organization}`);
  if (name?.organizationalUnit) parts.push(`OU = ${name.organizationalUnit}`);
  if (name?.commonName) parts.push(`CN = ${name.commonName}`);
  return parts.join(', ') || '(empty)';
}

/**
 * Public hosts the simulation's internet-connected workstation can reach (#49).
 * The IANA example domains are modelled because their content is stable; they
 * are the normal way to prove a machine has outbound connectivity. This keeps
 * the sandbox honest: the cluster network is fully simulated, other internet
 * hosts remain unknown to the sandbox DNS.
 */
const SIMULATED_INTERNET_HOSTS = new Set([
  'example.com',
  'www.example.com',
  'example.org',
  'www.example.org',
  'example.net',
  'www.example.net',
]);

/** The real https://example.com body (fetched 2026-11-05). */
const SIMULATED_INTERNET_HTML =
  '<!doctype html><html lang=en><head><meta charset=utf-8><link rel=icon href=data:,><meta name=viewport content="width=device-width,initial-scale=1"><title>Example Domain</title><style>html{color-scheme:light dark;background:light-dark(#eee,#222)}body{font:16px/1.6 system-ui,sans-serif;max-width:26em;margin:auto;padding:25vh 2em 2em;text-align:center}</style></head><body><p>This domain is for use in documentation examples without needing permission. This is not a service; avoid relying on it for testing and monitoring purposes.</p><script src=/s.js></script></body></html>';

export class ShellTools {
  /**
   * @param {import('./CommandBar.js').default} bar the owning CommandBar
   */
  constructor(bar) {
    this.bar = bar;
    /** Last command exit code / status, exposed for teaching hints. */
    this.lastExitCode = 0;
    /** Host used when no GameEngine provides one (standalone Node harnesses). */
    this._ownHost = null;
    /** Effective user while `sudo` runs a command (null = the session user). */
    this._euser = null;
    this._sudoDepth = 0;
    this._scriptDepth = 0;
  }

  /**
   * The simulated RHEL workstation (1.16.0). The GameEngine owns it (`gameEngine.linuxHost`)
   * so grading and level seeds see the same machine; a standalone ShellTools gets its own.
   * @returns {LinuxHost}
   */
  get host() {
    const shared = this.bar?.gameEngine?.linuxHost;
    if (shared) return shared;
    if (!this._ownHost) {
      this._ownHost = new LinuxHost({ fileStore: () => this.bar?.manifestEngine || null });
    }
    return this._ownHost;
  }

  /** The shell's working directory (lives in the host session so cd survives commands). */
  get cwd() {
    return this.host.session.cwd;
  }

  set cwd(value) {
    this.host.session.cwd = String(value || LINUX_HOME);
  }

  /**
   * Exported shell variables (`export NAME=value`, issue #50). They live in the host's
   * shell session (graded by the `env` objective) and reset with it, like a fresh login.
   * @type {Map<string, string>}
   */
  get env() {
    return this.host.session.env;
  }

  /**
   * Plain shell variables (`NAME=value`, not exported). Expand like exported
   * variables but are not listed by `env`/`printenv`, matching bash (#50).
   * @type {Map<string, string>}
   */
  get vars() {
    return this.host.session.vars;
  }

  /** The user commands run as: the `sudo` target while sudo runs, else the shell user. */
  _user() {
    return this._euser || this.host.session.user;
  }

  /** `[student@workstation ~]$` — the bash prompt of the current shell. */
  prompt() {
    return this.host.prompt();
  }

  /** Forget exported / shell variables and shell state (called on `engine:reset`). */
  resetSession() {
    this.env.clear();
    this.vars.clear();
    this.lastExitCode = 0;
    this._euser = null;
    this._sudoDepth = 0;
  }

  /**
   * The shell environment used for `$VAR` expansion and `env`/`printenv`:
   * the fixed workstation variables plus every exported variable.
   * @returns {Record<string, string>}
   */
  exportedEnvironment() {
    const host = this.host;
    const user = host.session.user;
    const home = host.homeOf(user);
    const environment = {
      SHELL: '/bin/bash',
      HISTCONTROL: 'ignoredups',
      HISTSIZE: '1000',
      HOSTNAME: host.hostname,
      PWD: host.session.cwd,
      LOGNAME: user,
      HOME: home,
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      USER: user,
      SHLVL: '1',
      KUBECONFIG: `${LINUX_HOME}/.kube/config`,
      PATH:
        user === 'root'
          ? '/root/.local/bin:/root/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin'
          : `${home}/.local/bin:${home}/bin:/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin`,
      MAIL: `/var/spool/mail/${user}`,
      _: '/usr/bin/env',
    };
    if (host.session.oldpwd) environment.OLDPWD = host.session.oldpwd;
    for (const [name, value] of this.env) environment[name] = String(value ?? '');
    return environment;
  }

  /**
   * Variables visible to `$NAME`/`${NAME}` expansion: the workstation
   * environment plus exported and plain shell variables (later wins), and bash's
   * special `$?` status parameter (issue #63).
   * @returns {Record<string, string>}
   */
  sessionEnvironment() {
    const environment = this.exportedEnvironment();
    for (const [name, value] of this.vars) environment[name] = String(value ?? '');
    // `$?` is a shell special parameter, not an environment variable: expose it
    // for expansion but never for `env`/`printenv`/`export` output (#63).
    environment['?'] = String(this.lastExitCode ?? 0);
    environment.$ = String(this.host.shellPid || 2297);
    if (this._scriptParams) Object.assign(environment, this._scriptParams);
    return environment;
  }

  /** Expand `$NAME`/`${NAME}`/`$?` for one shell segment (issues #50/#63). */
  expandVariables(text) {
    return expandShellVariables(text, this.sessionEnvironment());
  }

  /**
   * Parse a bare `NAME=value` shell assignment (`HOST=$(oc get route …)`).
   * Only a whole segment whose only token is the assignment qualifies; a
   * command prefix such as `FOO=bar oc get pods` is not modelled.
   * @param {string} text
   * @returns {{name: string, value: string}|null}
   */
  parseShellAssignment(text) {
    const tokens = tokenizeShell(text);
    if (tokens.length !== 1) return null;
    const token = tokens[0];
    const equals = token.indexOf('=');
    if (equals <= 0) return null;
    const name = token.slice(0, equals);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
    return { name, value: token.slice(equals + 1) };
  }

  /** Store a shell variable (exported or not) for later `$VAR` expansion. */
  setSessionVariable(name, value, { exported = false } = {}) {
    if (exported) this.env.set(name, String(value ?? ''));
    else this.vars.set(name, String(value ?? ''));
  }

  /** Split `a; b && c || d` into segments (issue #50). */
  splitCommandLine(command) {
    return splitShellSegments(command);
  }

  /** Clear simulator message for unsupported bash grammar (issue #50). */
  findUnsupportedShellSyntax(segments) {
    return findUnsupportedShellSyntax(segments);
  }

  // ── classification / preprocessing ───────────────────────────────────────

  /** True when the first token is a simulated shell command (no `oc` needed). */
  isShellLead(token) {
    const word = String(token ?? '');
    if (SHELL_COMMAND_SET.has(word.toLowerCase())) return true;
    // 1.16.0: a path (`./deploy.sh`, `~/bin/x`, `/usr/bin/ls`) or a script on $PATH
    // (`lab-info.sh` in ~/bin) is run by the shell, never sent to `oc`.
    if (/^(\.{1,2}\/|~\/|\/)/.test(word)) return true;
    if (/^[A-Za-z0-9_.-]+$/.test(word) && word.includes('.')) {
      try {
        return Boolean(
          this.host.findOnPath(word, this.exportedEnvironment().PATH, { user: 'root' })
        );
      } catch {
        return false;
      }
    }
    return false;
  }

  /** Bash reserved words that are shell input even though unsupported (#50). */
  isShellKeyword(token) {
    return [
      'for',
      'while',
      'until',
      'do',
      'done',
      'select',
      'if',
      'then',
      'elif',
      'else',
      'fi',
      'case',
      'esac',
      'function',
    ].includes(String(token ?? '').toLowerCase());
  }

  /** True when the whole command line should be treated as shell input. */
  isShellLine(command) {
    const text = String(command ?? '').trim();
    if (!text) return false;
    const first = tokenizeShell(text.split(/\s/)[0])[0] || '';
    if (/^[A-Za-z_][A-Za-z0-9_]*\(\)$/.test(first)) return true; // `foo() { … }`
    // `NAME=value` shell assignment.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return true;
    return this.isShellLead(first) || this.isShellKeyword(first);
  }

  // ── workstation file access (1.16.0: LinuxHost, cwd-relative, permission-checked) ──

  /**
   * Read a file as the effective user. `{ok, content, path}` or `{error: ERRNO, path}`
   * (ENOENT, EACCES, EISDIR, ENOTDIR …).
   */
  _readFileResult(path) {
    return this.host.readFile(String(path ?? ''), { user: this._user() });
  }

  /** File content or null (any failure). */
  _readFile(path) {
    const result = this._readFileResult(path);
    return result.ok ? result.content : null;
  }

  _fileExists(path) {
    return this.host.stat(String(path ?? ''), { user: this._user() }).ok;
  }

  /** `cmd: path: Permission denied` style error text for a failed read. */
  _readError(command, path, result) {
    return `${command}: ${path}: ${errnoText(result?.error || 'ENOENT')}`;
  }

  _writeFile(path, content, options = {}) {
    const written = this.host.writeFile(String(path ?? ''), String(content ?? ''), {
      user: this._user(),
      append: Boolean(options.append),
    });
    this._refreshFilesPanel();
    if (written.ok) return { ok: true, path: written.path };
    return { error: true, errno: written.error, message: errnoText(written.error) };
  }

  _deleteFile(path) {
    const removed = this.host.unlink(String(path ?? ''), { user: this._user() });
    this._refreshFilesPanel();
    return removed;
  }

  _refreshFilesPanel() {
    const panel = this.bar?.game?.manifestPanel || this.bar?.manifestPanel;
    if (panel && typeof panel.refresh === 'function' && panel.initialized) {
      try {
        panel.refresh();
      } catch {
        /* never break the terminal over a panel refresh */
      }
    }
  }

  /** True for an existing directory (the workstation filesystem, #76 / 1.16.0). */
  _isVirtualDirectory(path) {
    const found = this.host.stat(String(path ?? ''), { user: 'root' });
    return Boolean(found.ok && found.node.type === 'dir');
  }

  /**
   * Expand `$(command)` substitutions the way bash does before running a line.
   *
   * Bash expands command substitutions in unquoted and double-quoted words but
   * NOT inside single quotes (`'…$(cat …)…'` is passed literally to the command,
   * e.g. to a container `sh -c`). Quoting is tracked while scanning here so an
   * `oc exec … -- sh -c 'curl -H "Authorization: Bearer $(cat …/token)"'`
   * one-liner reaches the container shell with the substitution intact
   * (#75 L16). Word-final substitutions still expand and the value never ends
   * with stray whitespace (#75/#76).
   * @param {string} text
   * @returns {string}
   */
  expandSubstitutions(text) {
    const source = String(text ?? '');
    const expandAt = (index) => {
      const end = findCommandSubstitutionEnd(source, index);
      if (end < 0) return null;
      const inner = source.slice(index + 2, end);
      return { end, value: this._expandOneSubstitution(inner) };
    };
    let result = '';
    let quote = null;
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      if (quote === "'") {
        result += char;
        if (char === "'") quote = null;
        continue;
      }
      if (quote === '"') {
        if (char === '"') {
          quote = null;
          result += char;
          continue;
        }
        if (char === '\\' && index + 1 < source.length) {
          result += char + source[index + 1];
          index += 1;
          continue;
        }
        if (char === '$' && source[index + 1] === '(') {
          const expanded = expandAt(index);
          if (expanded) {
            result += expanded.value;
            index = expanded.end;
            continue;
          }
        }
        result += char;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        result += char;
        continue;
      }
      if (char === '\\' && index + 1 < source.length) {
        result += char + source[index + 1];
        index += 1;
        continue;
      }
      if (char === '$' && source[index + 1] === '(') {
        const expanded = expandAt(index);
        if (expanded) {
          result += expanded.value;
          index = expanded.end;
          continue;
        }
      }
      result += char;
    }
    return result;
  }

  /**
   * Run one `$(…)` body like bash: nested substitutions expand first, the
   * command runs on the workstation, and all trailing newlines are stripped
   * (bash command substitution semantics).
   * @param {string} inner the text between `$(` and the matching `)`
   * @returns {string}
   */
  _expandOneSubstitution(inner) {
    const command = this.expandSubstitutions(String(inner ?? '')).trim();
    // Bash strips ALL trailing newlines from a `$(…)` value; `_runSubcommand`
    // already trims, but strip defensively here too so a word-final
    // substitution can never inject whitespace into the surrounding word
    // (issue #75/#76: `curl http://$(oc get route … -o jsonpath=…)`).
    return this._runSubcommand(command).replace(/[\r\n]+$/, '');
  }

  _runSubcommand(command) {
    const expanded = this.expandVariables(command);
    const plan = splitShellSegments(expanded);
    if (plan.error) return '';
    const cliAvailable = typeof this.bar?._runSegment === 'function';
    const firstTokens = tokenizeShell(plan.segments[0] || '');
    const first = String(firstTokens[0] || '').toLowerCase();
    if (!cliAvailable) {
      // Standalone ShellTools (Node tests): only a single shell pipeline runs.
      const result = this.runTokens(firstTokens, null);
      const text = result && typeof result.message === 'string' ? result.message : '';
      return text.trim().replace(/\n+/g, ' ');
    }
    if (!(first === 'oc' || first === 'kubectl') && !this.isShellLead(first)) {
      // Not a command this simulator knows; let the CLI surface its error when
      // the (unevaluated) substitution is re-run as part of the line.
      return '';
    }
    // Run every `;`/`&&`/`||` segment of the substitution like a shell would,
    // capturing stdout only (#50). Values are never re-parsed as operators.
    const outputs = [];
    let lastStatus = true;
    for (let index = 0; index < plan.segments.length; index += 1) {
      const separator = index === 0 ? null : plan.operators[index - 1];
      const shouldRun =
        index === 0 ||
        separator === ';' ||
        (separator === '&&' && lastStatus) ||
        (separator === '||' && !lastStatus);
      if (!shouldRun) continue;
      const segment = String(plan.segments[index] || '').trim();
      if (!segment) continue;
      const result = this.bar._runSegment(segment, null, false);
      lastStatus = !result.error;
      // Command substitution captures stdout only: stderr (error messages) is
      // not part of the substituted value, exactly like bash.
      const text = result.output || '';
      if (text) outputs.push(text.replace(/\n$/, ''));
    }
    return outputs.join('\n').trim().replace(/\n+/g, ' ');
  }

  /**
   * Handle heredocs and command substitution for a raw input line.
   * @param {string} raw
   * @returns {{command: string, stdin: string|null, display: string}}
   */
  preprocess(raw) {
    const original = String(raw ?? '');
    // Common shell redirections learners type on the exam; the simulator only
    // models stdout, so drop stderr-suppression segments rather than treating
    // them as command arguments.
    const withoutStderrRedirects = original
      .replace(/\s*2>\/dev\/null/g, '')
      .replace(/\s*2>&1/g, '')
      .replace(/\s*&>\/dev\/null/g, '');
    const expanded = this.expandSubstitutions(withoutStderrRedirects);
    const newline = expanded.indexOf('\n');
    if (newline >= 0) {
      const header = expanded.slice(0, newline);
      const body = expanded.slice(newline + 1);
      const heredoc = header.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
      if (heredoc) {
        const delimiter = heredoc[2];
        const lines = body.split('\n');
        let end = lines.findIndex((line) => line.replace(/^\t+/, '').trimEnd() === delimiter);
        if (end < 0) end = lines.length;
        const bodyLines = lines.slice(0, end);
        const command =
          header
            .replace(/<<-?\s*(['"]?)[A-Za-z_][A-Za-z0-9_]*\1/, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim() || 'cat';
        return {
          command,
          stdin: `${bodyLines.join('\n')}\n`,
          display: header.trim(),
        };
      }
    }
    return { command: expanded, stdin: null, display: original.split('\n')[0] };
  }

  /**
   * Execute one shell pipeline stage.
   * @param {string[]} tokens argv (command included)
   * @param {string|null} stdin piped/heredoc input
   * @returns {{error: boolean, message: string, exitCode: number, clear?: boolean}}
   */
  runTokens(tokens, stdin) {
    const typed = String(tokens[0] || '');
    const name = typed.toLowerCase();
    const args = tokens.slice(1);
    const input = stdin === null || stdin === undefined ? null : String(stdin);
    const finish = (result) => {
      // A handler can report its real status (`grep` exits 1 on no match);
      // otherwise any failed command is status 1 and a successful one 0 (#63).
      if (!Number.isFinite(result.exitCode)) result.exitCode = result.error ? 1 : 0;
      this.lastExitCode = result.exitCode;
      this._recordExec(typed, args, result);
      return result;
    };
    // 1.16.0: `./script.sh`, `/path/to/tool`, or a script found on $PATH.
    if (typed.includes('/') || (!this[`_cmd_${name}`] && this.isShellLead(typed))) {
      try {
        return finish(this._runExecutable(typed, args, input));
      } catch (error) {
        return finish({
          error: true,
          message: `bash: ${typed}: ${error?.message || error}`,
          exitCode: 126,
        });
      }
    }
    const handler = this[`_cmd_${name}`];
    // Commands from packages that are not installed (`dnf remove bind-utils` → no `dig`).
    if (!handler || !this.host.commandAvailable(name)) {
      return finish({ error: true, message: `bash: ${typed}: command not found`, exitCode: 127 });
    }
    try {
      this.host.sync();
      const result = handler.call(this, args, input) || { error: false, message: '' };
      return finish(result);
    } catch (error) {
      return finish({
        error: true,
        message: `${name}: ${error && error.message ? error.message : error}`,
        exitCode: 1,
      });
    }
  }

  /** Remember an executed command for the `ran` objective (argv, cwd, resolved paths). */
  _recordExec(command, args, result) {
    try {
      const host = this.host;
      const paths = [];
      for (const arg of args) {
        if (!arg || arg.startsWith('-') || arg.length > 300) continue;
        const found = host.stat(arg, { user: 'root' });
        if (found.ok) paths.push(found.path);
      }
      host.recordExec({
        command: String(command).replace(/^.*\//, ''),
        argv: [command, ...args],
        paths,
        exitCode: result.exitCode,
        success: result.exitCode === 0,
        sudo: this._sudoDepth > 0,
        user: this._user(),
      });
    } catch {
      /* grading evidence is best-effort */
    }
  }

  /**
   * Run one pipeline stage from its raw text (CommandBar `_runStage`): quote-aware word
   * splitting with bash expansions the simulator models — `~`, brace `{a,b}`, globs
   * `* ? [..]` against the workstation filesystem (unquoted only), `#` comments and a
   * `< file` input redirect.
   * @param {string} text the stage (variables/substitutions already expanded)
   * @param {string|null} stdin
   */
  runShellStage(text, stdin) {
    const parsed = this.expandWords(text);
    if (parsed.error) {
      this.lastExitCode = 1;
      return { error: true, message: parsed.error, exitCode: 1 };
    }
    let input = stdin;
    if (parsed.inputFile !== null) {
      const read = this._readFileResult(parsed.inputFile);
      if (!read.ok) {
        this.lastExitCode = 1;
        return {
          error: true,
          message: `bash: ${parsed.inputFile}: ${errnoText(read.error)}`,
          exitCode: 1,
        };
      }
      input = read.content;
    }
    if (!parsed.words.length) return { error: false, message: '' };
    return this.runTokens(parsed.words, input);
  }

  /**
   * bash word expansion for one simple command. Returns `{words, inputFile}`.
   * @param {string} text
   */
  expandWords(text) {
    const source = String(text ?? '');
    const words = [];
    let inputFile = null;
    let expectInput = false;
    let current = [];
    let started = false;
    let quote = null;
    const flush = () => {
      if (!started) return;
      const expanded = this._expandWord(current);
      current = [];
      started = false;
      if (expectInput) {
        inputFile = expanded[0] ?? '';
        expectInput = false;
        return;
      }
      words.push(...expanded);
    };
    for (let index = 0; index < source.length; index += 1) {
      const ch = source[index];
      if (quote) {
        if (ch === quote) {
          quote = null;
          continue;
        }
        if (ch === '\\' && quote === '"' && /["\\$`]/.test(source[index + 1] || '')) {
          current.push({ ch: source[index + 1], quoted: true });
          index += 1;
          continue;
        }
        current.push({ ch, quoted: true });
        continue;
      }
      if (ch === '\\' && index + 1 < source.length) {
        current.push({ ch: source[index + 1], quoted: true });
        started = true;
        index += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        started = true;
        continue;
      }
      if (/\s/.test(ch)) {
        flush();
        continue;
      }
      if (ch === '#' && !started) break;
      if (ch === '<' && !started) {
        flush();
        expectInput = true;
        continue;
      }
      current.push({ ch, quoted: false });
      started = true;
    }
    if (quote) return { error: 'bash: unexpected EOF while looking for matching `' + quote + "'" };
    flush();
    if (expectInput) return { error: "bash: syntax error near unexpected token `newline'" };
    return { words, inputFile };
  }

  /** Expand one word (array of {ch, quoted}) → one or more argv entries. */
  _expandWord(chars) {
    // Brace expansion first (unquoted `{a,b}` with at least one comma).
    const text = chars.map((entry) => entry.ch).join('');
    const braceOpen = chars.findIndex(
      (entry, index) =>
        entry.ch === '{' &&
        !entry.quoted &&
        chars.slice(index).some((e) => e.ch === '}' && !e.quoted)
    );
    if (braceOpen >= 0) {
      let depth = 0;
      let close = -1;
      const commas = [];
      for (let index = braceOpen; index < chars.length; index += 1) {
        const entry = chars[index];
        if (entry.quoted) continue;
        if (entry.ch === '{') depth += 1;
        else if (entry.ch === '}') {
          depth -= 1;
          if (depth === 0) {
            close = index;
            break;
          }
        } else if (entry.ch === ',' && depth === 1) commas.push(index);
      }
      if (close > braceOpen && commas.length) {
        const prefix = chars.slice(0, braceOpen);
        const suffix = chars.slice(close + 1);
        const bounds = [braceOpen, ...commas, close];
        const results = [];
        for (let index = 0; index < bounds.length - 1; index += 1) {
          const middle = chars.slice(bounds[index] + 1, bounds[index + 1]);
          results.push(...this._expandWord([...prefix, ...middle, ...suffix]));
        }
        return results;
      }
    }
    // Tilde expansion (`~`, `~/x`, `~user/x`) at the start of an unquoted word.
    let word = text;
    if (chars.length && chars[0].ch === '~' && !chars[0].quoted) {
      const slash = text.indexOf('/');
      const user = (slash < 0 ? text : text.slice(0, slash)).slice(1);
      const host = this.host;
      if (!user || host.users.has(user)) {
        const home = user ? host.homeOf(user) : host.homeOf(host.session.user);
        word = `${home}${slash < 0 ? '' : text.slice(slash)}`;
        chars = [
          ...[...home].map((ch) => ({ ch, quoted: true })),
          ...chars.slice(slash < 0 ? chars.length : slash),
        ];
      }
    }
    // Pathname expansion for unquoted glob characters.
    const globbing = chars.some((entry) => !entry.quoted && /[*?[]/.test(entry.ch));
    if (!globbing) return [word];
    const matches = this._glob(chars);
    return matches.length ? matches : [word];
  }

  /** Match a glob word against the workstation filesystem (sorted, dotfiles need a dot). */
  _glob(chars) {
    const word = chars.map((entry) => entry.ch).join('');
    const absolute = word.startsWith('/');
    const segments = [];
    let segment = [];
    for (const entry of chars) {
      if (entry.ch === '/') {
        segments.push(segment);
        segment = [];
      } else segment.push(entry);
    }
    segments.push(segment);
    const host = this.host;
    let bases = [absolute ? '' : null];
    const user = this._user();
    for (let index = 0; index < segments.length; index += 1) {
      const part = segments[index];
      if (!part.length) continue;
      const literal = part.map((entry) => entry.ch).join('');
      const hasGlob = part.some((entry) => !entry.quoted && /[*?[]/.test(entry.ch));
      const next = [];
      for (const base of bases) {
        const prefix = base === null ? '' : `${base}/`;
        if (!hasGlob) {
          next.push(base === null ? literal : `${prefix}${literal}`);
          continue;
        }
        const dir = base === null ? '.' : base === '' ? '/' : base;
        const listing = host.readdir(dir, { user });
        if (!listing.ok) continue;
        const pattern = part
          .map((entry) => (entry.quoted && /[*?[\]]/.test(entry.ch) ? `[${entry.ch}]` : entry.ch))
          .join('');
        const regex = globToRegExp(pattern);
        for (const entry of listing.entries) {
          if (entry.name.startsWith('.') && !literal.startsWith('.')) continue;
          if (regex.test(entry.name))
            next.push(base === null ? entry.name : `${prefix}${entry.name}`);
        }
      }
      bases = next;
      if (!bases.length) return [];
    }
    void hasGlobChars;
    return bases
      .filter((path) => path !== null && host.stat(path, { user: 'root', follow: false }).ok)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }

  // ── file helpers ─────────────────────────────────────────────────────────

  /**
   * Expand a leading `~`/`~/` to the workstation home. The virtual filesystem
   * is rooted at the home directory, so `~/auth/kubeadmin-password` maps to
   * `auth/kubeadmin-password` (issue #42-4) while plain relative paths keep
   * working.
   * @param {string} path
   * @returns {string}
   */
  expandHomePath(path) {
    // 1.16.0: the ONE resolver lives in LinuxHost (cwd, `~`, `/tmp`); this returns the
    // Files-panel key of a home/tmp path (`~/auth/x` → `auth/x`, `/tmp/x` → `tmp/x`).
    const raw = String(path ?? '');
    const home = raw.match(/^\$(?:\{HOME\}|HOME)(\/.*)?$/);
    const key = this.host.vfsKey(home ? `~${home[1] || ''}` : raw);
    return key === null ? raw : key;
  }

  _readInputFiles(args, stdin, commandName) {
    const files = args.filter((arg) => !arg.startsWith('-'));
    if (!files.length) return { contents: stdin === null ? '' : stdin, label: null, files: [] };
    const parts = [];
    for (const file of files) {
      const read = this._readFileResult(file);
      if (!read.ok) return { error: this._readError(commandName, file, read) };
      parts.push({ file, content: read.content });
    }
    return { contents: parts.map((entry) => entry.content).join('\n'), parts, files };
  }

  _ok(message = '') {
    return { error: false, message };
  }

  _err(message) {
    return { error: true, message };
  }

  // ── cat / echo ───────────────────────────────────────────────────────────

  _cmd_cat(args, stdin) {
    const flags = new Set();
    const files = [];
    for (const arg of args) {
      if (arg === '--show-all') flags.add('A');
      else if (arg === '--number') flags.add('n');
      else if (arg.startsWith('--')) continue;
      else if (/^-[A-Za-z]+$/.test(arg)) for (const flag of arg.slice(1)) flags.add(flag);
      else files.push(arg);
    }
    // `cat -A` = -vET: `^I` for tabs and `$` at every line end (a final line without
    // a newline gets no `$`, like GNU cat).
    const render = (text) => {
      let output = String(text ?? '');
      const showEnds = flags.has('A') || flags.has('E') || flags.has('e');
      const showTabs = flags.has('A') || flags.has('T') || flags.has('t');
      if (showTabs) output = output.replace(/\t/g, '^I');
      if (showEnds) output = output.replace(/\n/g, '$\n');
      if (flags.has('n') || flags.has('b')) {
        let number = 0;
        const lines = output.split('\n');
        const last = lines.length - 1;
        output = lines
          .map((line, index) => {
            if (index === last && line === '') return line;
            if (flags.has('b') && line === '') return line;
            number += 1;
            return `${String(number).padStart(6)}\t${line}`;
          })
          .join('\n');
      }
      return output;
    };
    if (!files.length) return this._ok(render(stdin === null ? '' : stdin));
    const chunks = [];
    const errors = [];
    for (const file of files) {
      if (file === '-') {
        chunks.push(stdin === null ? '' : stdin);
        continue;
      }
      const read = this._readFileResult(file);
      if (!read.ok) {
        errors.push(this._readError('cat', file, read));
        continue;
      }
      chunks.push(read.content);
    }
    const text = render(chunks.join(''));
    if (errors.length) {
      // GNU cat prints what it could read and reports every failure (exit 1).
      return {
        error: true,
        message: [text.replace(/\n$/, ''), ...errors].filter(Boolean).join('\n'),
        exitCode: 1,
      };
    }
    // The terminal shows one block per output (#76: no trailing blank line); `stdout`
    // keeps the exact bytes for `cat a > b`.
    return { error: false, message: text.replace(/\n$/, ''), stdout: text };
  }

  _cmd_echo(args, stdin) {
    let interpret = false;
    let noNewline = false;
    const words = [];
    for (const arg of args) {
      if (/^-[neE]+$/.test(arg)) {
        // `-n` only suppresses echo's trailing newline; the terminal renders one
        // line block per output, so it never needs the byte here (#76). `-e`
        // does change the payload (escape sequences).
        if (arg.includes('e')) interpret = true;
        if (arg.includes('n')) noNewline = true;
        continue;
      }
      words.push(arg);
    }
    let text = words.join(' ');
    if (interpret) {
      text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
    }
    if (stdin !== null && stdin !== '') text = words.length ? `${text}\n${stdin}` : stdin;
    // #76: the terminal renders one block per command output, so a trailing
    // newline in the message would show as an extra blank line after `echo`;
    // no other shell builtin ends its message with a newline either. The exact
    // bytes (`stdout`, with echo's newline unless -n) are what `>`/`>>` write.
    return { error: false, message: text, stdout: noNewline ? text : `${text}\n` };
  }

  // ── grep / head / tail / wc ──────────────────────────────────────────────

  _cmd_grep(args, stdin) {
    const flags = {
      ignoreCase: false,
      invert: false,
      lineNumbers: false,
      count: false,
      filesWithMatches: false,
      onlyMatching: false,
      after: 0,
      before: 0,
    };
    let pattern = null;
    let fromPatternFlag = false;
    const files = [];
    const parseContext = (value, setter) => {
      const parsed = Number.parseInt(String(value), 10);
      if (Number.isFinite(parsed) && parsed >= 0) setter(parsed);
    };
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === '-e' || arg === '--regexp') {
        pattern = args[++i] ?? null;
        fromPatternFlag = true;
        continue;
      }
      if (/^-[A-Za-z]/.test(arg) && !arg.startsWith('--')) {
        // Handle combined short flags incl. attached context counts:
        // -iA2, -A2, -B 2 (value in the next argv), -C1 …
        let rest = arg.slice(1);
        let consumedNext = false;
        while (rest.length > 0) {
          const char = rest[0];
          if (char === 'A' || char === 'B' || char === 'C') {
            const attached = rest.slice(1);
            const setter =
              char === 'A'
                ? (value) => {
                    flags.after = value;
                  }
                : char === 'B'
                  ? (value) => {
                      flags.before = value;
                    }
                  : (value) => {
                      flags.after = value;
                      flags.before = value;
                    };
            if (attached) {
              parseContext(attached, setter);
              rest = '';
            } else if (i + 1 < args.length && /^\d+$/.test(args[i + 1])) {
              parseContext(args[++i], setter);
              rest = '';
              consumedNext = true;
            } else {
              setter(0);
              rest = rest.slice(1);
            }
            continue;
          }
          if (char === 'i') flags.ignoreCase = true;
          else if (char === 'v') flags.invert = true;
          else if (char === 'n') flags.lineNumbers = true;
          else if (char === 'c') flags.count = true;
          else if (char === 'l') flags.filesWithMatches = true;
          else if (char === 'o') flags.onlyMatching = true;
          else if (char === 'w') flags.word = true;
          else if (char === 'r' || char === 'R') flags.recursive = true;
          else if (char === 'q') flags.quiet = true;
          else if (char === 'h') flags.noFilename = true;
          else if (char === 'H') flags.withFilename = true;
          // -E/-F/--color etc. accepted; JS regular expressions cover ERE.
          rest = rest.slice(1);
        }
        void consumedNext;
        continue;
      }
      if (arg.startsWith('--')) continue;
      if (pattern === null && !fromPatternFlag) {
        pattern = arg;
        continue;
      }
      files.push(arg);
    }
    if (pattern === null)
      return this._err('usage: grep [-ivnc] [-A num] [-B num] [-C num] pattern [file ...]');
    let matcher;
    // Basic-regex alternation (`a\|b`) and grouping are written with backslashes in GNU grep.
    const jsPattern = String(pattern)
      .replace(/\\\|/g, '|')
      .replace(/\\([(){}])/g, '$1');
    try {
      matcher = new RegExp(
        flags.word ? `(?<![\\w])(?:${jsPattern})(?![\\w])` : jsPattern,
        flags.ignoreCase ? 'i' : ''
      );
    } catch {
      matcher = new RegExp(
        pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        flags.ignoreCase ? 'i' : ''
      );
    }
    if (flags.recursive) {
      // `grep -r PATTERN [DIR…]`: every readable regular file below the operands.
      const roots = files.length ? [...files] : ['.'];
      files.length = 0;
      const walk = (path) => {
        const listing = this.host.readdir(path, { user: this._user() });
        if (!listing.ok) {
          if (listing.error === 'ENOTDIR') files.push(path);
          return;
        }
        for (const entry of listing.entries) {
          const child = path === '.' ? entry.name : `${path.replace(/\/+$/, '')}/${entry.name}`;
          if (entry.node.type === 'dir') walk(child);
          else if (entry.node.type === 'file') files.push(child);
        }
      };
      for (const root of roots) walk(root);
      if (files.length > 1 || roots.some((root) => this._isVirtualDirectory(root)))
        flags.withFilename = true;
    }
    const hasContext = flags.after > 0 || flags.before > 0;
    const sources = files.length
      ? files.map((file) => {
          const read = this._readFileResult(file);
          return { label: file, content: read.ok ? read.content : null, read };
        })
      : [{ label: null, content: stdin === null ? '' : stdin }];
    const output = [];
    let matchedAny = false;
    for (const source of sources) {
      if (source.content === null) {
        // grep reports unreadable files and exits 2 (trouble), like GNU grep.
        return {
          error: true,
          message: `grep: ${source.label}: ${errnoText(source.read?.error)}`,
          exitCode: 2,
        };
      }
      const lines = String(source.content).split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      const matchedIndexes = [];
      lines.forEach((line, index) => {
        const isMatch = matcher.test(line);
        if (isMatch !== flags.invert) matchedIndexes.push(index);
      });
      if (matchedIndexes.length) matchedAny = true;
      if (flags.filesWithMatches) {
        if (matchedIndexes.length && source.label) output.push(source.label);
        continue;
      }
      if (flags.count) {
        output.push(
          (sources.length > 1 || flags.withFilename) && !flags.noFilename && source.label
            ? `${source.label}:${matchedIndexes.length}`
            : String(matchedIndexes.length)
        );
        continue;
      }
      const multiFilePrefix =
        (sources.length > 1 || flags.withFilename) && !flags.noFilename && source.label
          ? `${source.label}:`
          : '';
      if (!hasContext) {
        for (const index of matchedIndexes) {
          const line = lines[index];
          const prefix = `${multiFilePrefix}${flags.lineNumbers ? `${index + 1}:` : ''}`;
          if (flags.onlyMatching) {
            const matches = [
              ...line.matchAll(new RegExp(matcher.source, flags.ignoreCase ? 'gi' : 'g')),
            ].map((entry) => entry[0]);
            for (const value of matches) output.push(`${prefix}${value}`);
          } else {
            output.push(`${prefix}${line}`);
          }
        }
        continue;
      }
      // Context groups (-A/-B/-C): include surrounding lines, separated by `--`
      // between non-contiguous groups, exactly like real grep.
      const selected = new Set();
      for (const index of matchedIndexes) {
        for (let cursor = index - flags.before; cursor <= index + flags.after; cursor += 1) {
          if (cursor >= 0 && cursor < lines.length) selected.add(cursor);
        }
      }
      const indexes = [...selected].sort((a, b) => a - b);
      let previous = -1;
      for (const index of indexes) {
        if (previous >= 0 && index !== previous + 1) output.push('--');
        const prefix = `${multiFilePrefix}${flags.lineNumbers ? `${index + 1}:` : ''}`;
        output.push(`${prefix}${lines[index]}`);
        previous = index;
      }
    }
    const text = output.join('\n');
    // Real grep exits 1 when nothing matched; `-c`/`-l` still print "0"/nothing,
    // so this is a failed shell status without an error message (#63).
    if (!matchedAny) return { error: false, message: flags.quiet ? '' : text, exitCode: 1 };
    if (flags.quiet) return this._ok('');
    return this._ok(text);
  }

  _cmd_head(args, stdin) {
    return this._headTail(args, stdin, 'head');
  }

  _cmd_tail(args, stdin) {
    return this._headTail(args, stdin, 'tail');
  }

  _headTail(args, stdin, name) {
    let count = 10;
    const files = [];
    const positional = [];
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === '-n' || arg === '--lines') {
        const value = Number.parseInt(args[++i], 10);
        if (Number.isFinite(value)) count = value;
        continue;
      }
      const short = arg.match(/^-(\d+)$/);
      if (short) {
        count = Number(short[1]);
        continue;
      }
      if (/^-n\d+$/.test(arg)) {
        count = Number(arg.slice(2));
        continue;
      }
      if (arg.startsWith('-')) continue; // -f/-q etc.
      positional.push(arg);
    }
    const run = (content) => {
      const lines = String(content).split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      if (name === 'head') return lines.slice(0, count).join('\n');
      return lines.slice(Math.max(0, lines.length - count)).join('\n');
    };
    if (!positional.length) return this._ok(run(stdin === null ? '' : stdin));
    const out = [];
    for (const file of positional) {
      const read = this._readFileResult(file);
      if (!read.ok) {
        const reason =
          read.error === 'EISDIR'
            ? `${name}: error reading '${file}': Is a directory`
            : `${name}: cannot open '${file}' for reading: ${errnoText(read.error)}`;
        return this._err(reason);
      }
      if (positional.length > 1) out.push(`==> ${file} <==`);
      out.push(run(read.content));
      if (positional.length > 1) out.push('');
    }
    return this._ok(out.join('\n').replace(/\n+$/, ''));
  }

  _cmd_wc(args, stdin) {
    const flags = new Set(
      args.filter((arg) => /^-[lwc]+$/.test(arg)).flatMap((arg) => arg.slice(1).split(''))
    );
    const files = args.filter((arg) => !arg.startsWith('-'));
    const countsFor = (content) => {
      const text = String(content ?? '');
      return {
        l:
          text === ''
            ? 0
            : text
                .split('\n')
                .filter((line, index, list) => !(index === list.length - 1 && line === '')).length,
        w: countWords(text),
        c: text.length,
      };
    };
    const format = (counts) => {
      if (flags.size) {
        return [...flags]
          .sort()
          .map((flag) => counts[flag])
          .join(' ');
      }
      return `${counts.l} ${counts.w} ${counts.c}`;
    };
    if (!files.length) return this._ok(format(countsFor(stdin === null ? '' : stdin)));
    const lines = [];
    let total = { l: 0, w: 0, c: 0 };
    for (const file of files) {
      const read = this._readFileResult(file);
      if (!read.ok) {
        if (read.error === 'EISDIR') {
          lines.push(`wc: ${file}: Is a directory`, `${format({ l: 0, w: 0, c: 0 })} ${file}`);
          continue;
        }
        return this._err(this._readError('wc', file, read));
      }
      const content = read.content;
      const counts = countsFor(content);
      total = { l: total.l + counts.l, w: total.w + counts.w, c: total.c + counts.c };
      lines.push(`${format(counts)} ${file}`);
    }
    if (files.length > 1) lines.push(`${format(total)} total`);
    return this._ok(lines.join('\n'));
  }

  // ── text utilities ───────────────────────────────────────────────────────

  _cmd_sort(args, stdin) {
    let numeric = false;
    let reverse = false;
    let unique = false;
    let ignoreCase = false;
    let human = false;
    let separator = null;
    let key = null;
    const files = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '-t' || arg === '--field-separator') {
        separator = args[++index] ?? null;
        continue;
      }
      if (arg.startsWith('-t') && arg.length > 2) {
        separator = arg.slice(2);
        continue;
      }
      if (arg === '-k' || arg === '--key') {
        key = args[++index] ?? null;
        continue;
      }
      if (arg.startsWith('-k') && arg.length > 2) {
        key = arg.slice(2);
        continue;
      }
      if (arg.startsWith('--key=')) {
        key = arg.slice(6);
        continue;
      }
      if (/^-[a-zA-Z]+$/.test(arg)) {
        for (const flag of arg.slice(1)) {
          if (flag === 'n') numeric = true;
          else if (flag === 'r') reverse = true;
          else if (flag === 'u') unique = true;
          else if (flag === 'f') ignoreCase = true;
          else if (flag === 'h') human = true;
        }
        continue;
      }
      if (arg.startsWith('--')) continue;
      files.push(arg);
    }
    let input;
    if (files.length) {
      const chunks = [];
      for (const file of files) {
        const read = this._readFileResult(file);
        if (!read.ok) {
          return {
            error: true,
            message: `sort: cannot read: ${file}: ${errnoText(read.error)}`,
            exitCode: 2,
          };
        }
        chunks.push(read.content.endsWith('\n') ? read.content : `${read.content}\n`);
      }
      input = chunks.join('');
    } else input = stdin === null ? '' : stdin;
    let lines = String(input).split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    // `-k N[,M]`: compare from field N (fields split on -t, else on blank runs).
    const keyOf = (line) => {
      if (!key) return line;
      const [startSpec, endSpec] = String(key).split(',');
      const start = Math.max(1, Number.parseInt(startSpec, 10) || 1);
      const end = endSpec ? Number.parseInt(endSpec, 10) || start : null;
      const fields = separator !== null ? line.split(separator) : line.trim().split(/\s+/);
      const slice = fields.slice(start - 1, end ? end : undefined);
      return slice.join(separator !== null ? separator : ' ');
    };
    const humanValue = (text) => {
      const match = String(text)
        .trim()
        .match(/^(-?[\d.]+)([KMGTP]?)/i);
      if (!match) return 0;
      const power = ' KMGTP'.indexOf((match[2] || ' ').toUpperCase());
      return Number.parseFloat(match[1]) * 1024 ** Math.max(0, power);
    };
    const compare = (left, right) => {
      const a = keyOf(left);
      const b = keyOf(right);
      if (numeric || human) {
        const x = human ? humanValue(a) : Number.parseFloat(a) || 0;
        const y = human ? humanValue(b) : Number.parseFloat(b) || 0;
        if (x !== y) return x - y;
        return left < right ? -1 : left > right ? 1 : 0;
      }
      const ka = ignoreCase ? a.toLowerCase() : a;
      const kb = ignoreCase ? b.toLowerCase() : b;
      const primary = ka.localeCompare(kb);
      if (primary !== 0) return primary;
      return left < right ? -1 : left > right ? 1 : 0;
    };
    lines.sort(compare);
    if (reverse) lines.reverse();
    if (unique) {
      lines = lines.filter((line, index) => index === 0 || compare(line, lines[index - 1]) !== 0);
    }
    return this._ok(lines.join('\n'));
  }

  _cmd_uniq(args, stdin) {
    const count = args.includes('-c');
    const lines = String(stdin === null ? '' : stdin).split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const out = [];
    for (const line of lines) {
      const last = out[out.length - 1];
      if (count && last && last.line === line) last.n += 1;
      else out.push({ line, n: 1 });
    }
    return this._ok(
      out
        .map((entry) => (count ? `${String(entry.n).padStart(7)} ${entry.line}` : entry.line))
        .join('\n')
    );
  }

  /**
   * `cut` (issue #32e): field selection (`-d` + `-f`) plus the character ranges
   * learners pipe command output through — `… | cut -c1-20` — including open
   * ranges (`-c5-`, `-c-5`), lists (`-c1,5,10-12`) and `--complement`.
   */
  _cmd_cut(args, stdin) {
    let delimiter = '\t';
    let fieldSpec = null;
    let charSpec = null;
    let complement = false;
    let onlyDelimited = false;
    const files = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '-d' || arg === '--delimiter') {
        delimiter = args[++index] ?? '\t';
        continue;
      }
      if (arg.startsWith('--delimiter=')) {
        delimiter = arg.slice('--delimiter='.length);
        continue;
      }
      if (arg.startsWith('-d') && arg.length > 2) {
        delimiter = arg.slice(2);
        continue;
      }
      if (arg === '-f' || arg === '--fields') {
        fieldSpec = String(args[++index] ?? '');
        continue;
      }
      if (arg.startsWith('--fields=')) {
        fieldSpec = arg.slice('--fields='.length);
        continue;
      }
      if (arg.startsWith('-f') && arg.length > 2) {
        fieldSpec = arg.slice(2);
        continue;
      }
      if (arg === '-c' || arg === '--characters') {
        charSpec = String(args[++index] ?? '');
        continue;
      }
      if (arg.startsWith('--characters=')) {
        charSpec = arg.slice('--characters='.length);
        continue;
      }
      if (arg.startsWith('-c') && arg.length > 2) {
        charSpec = arg.slice(2);
        continue;
      }
      if (arg === '--complement') {
        complement = true;
        continue;
      }
      if (arg === '-s' || arg === '--only-delimited') {
        onlyDelimited = true;
        continue;
      }
      if (arg === '--output-delimiter' || arg.startsWith('--output-delimiter=')) {
        if (arg === '--output-delimiter') index += 1;
        continue;
      }
      if (arg.startsWith('-')) return this._err(`cut: invalid option -- '${arg.slice(1)}'`);
      files.push(arg);
    }
    const usage = 'cut: you must specify a list of bytes, characters, or fields';
    if (charSpec !== null && fieldSpec !== null) {
      return this._err('cut: only one type of list may be specified');
    }
    if (charSpec === null && fieldSpec === null) return this._err(usage);
    if ([...String(delimiter)].length !== 1) {
      return this._err('cut: the delimiter must be a single character');
    }
    const parseRanges = (spec) => {
      const ranges = [];
      for (const rawPart of String(spec ?? '').split(/[,\s]+/)) {
        const part = rawPart.trim();
        if (!part) continue;
        const match = part.match(/^(\d*)(?:-(\d*))?$/);
        if (!match) return null;
        const hasDash = part.includes('-');
        let from;
        let to;
        if (!hasDash) {
          from = Number.parseInt(match[1], 10);
          to = from;
        } else if (match[1] === '' && (match[2] === undefined || match[2] === '')) {
          return null;
        } else if (match[1] === '') {
          from = 1;
          to = Number.parseInt(match[2], 10);
        } else if (match[2] === undefined || match[2] === '') {
          from = Number.parseInt(match[1], 10);
          to = Number.POSITIVE_INFINITY;
        } else {
          from = Number.parseInt(match[1], 10);
          to = Number.parseInt(match[2], 10);
        }
        if (!Number.isFinite(from) || from < 1 || Number.isNaN(to) || (to < from && to !== 0)) {
          return null;
        }
        ranges.push({ from, to });
      }
      return ranges.length ? ranges : null;
    };
    const charRanges = charSpec === null ? null : parseRanges(charSpec);
    if (charSpec !== null && !charRanges) return this._err(`cut: invalid range: '${charSpec}'`);
    const fieldRanges = fieldSpec === null ? null : parseRanges(fieldSpec);
    if (fieldSpec !== null && !fieldRanges) return this._err(`cut: invalid range: '${fieldSpec}'`);
    const selectedIndexes = (ranges, length) => {
      const selected = new Set();
      for (const { from, to } of ranges) {
        const last = Math.min(to, length);
        for (let position = from; position <= last; position += 1) selected.add(position - 1);
      }
      if (!complement) return [...selected].sort((left, right) => left - right);
      const inverted = [];
      for (let position = 0; position < length; position += 1) {
        if (!selected.has(position)) inverted.push(position);
      }
      return inverted;
    };
    let input;
    if (files.length) {
      const chunks = [];
      for (const file of files) {
        const content = this._readFile(file);
        if (content === null) return this._err(`cut: ${file}: No such file or directory`);
        chunks.push(content);
      }
      input = chunks.join('\n');
    } else {
      input = stdin === null || stdin === undefined ? '' : String(stdin);
    }
    const lines = input.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const output = [];
    for (const line of lines) {
      if (charRanges) {
        const characters = Array.from(line);
        output.push(
          selectedIndexes(charRanges, characters.length)
            .map((position) => characters[position])
            .join('')
        );
        continue;
      }
      const parts = line.split(delimiter);
      if (onlyDelimited && parts.length === 1) continue;
      output.push(
        selectedIndexes(fieldRanges, parts.length)
          .map((position) => parts[position])
          .join(delimiter)
      );
    }
    return this._ok(output.join('\n'));
  }

  _cmd_tr(args, stdin) {
    if (args.length < 2) return this._err('tr: missing operand');
    const input = String(stdin === null ? '' : stdin);
    const [from, to] = args;
    const expand = (set) => {
      const chars = [];
      for (let i = 0; i < set.length; i += 1) {
        if (set[i + 1] === '-' && i + 2 < set.length) {
          for (let code = set.charCodeAt(i); code <= set.charCodeAt(i + 2); code += 1)
            chars.push(String.fromCharCode(code));
          i += 2;
        } else {
          chars.push(set[i]);
        }
      }
      return chars;
    };
    const fromChars = expand(from);
    const toChars = expand(to);
    let out = '';
    for (const char of input) {
      const index = fromChars.indexOf(char);
      out += index >= 0 ? (toChars[index] ?? toChars[toChars.length - 1] ?? char) : char;
    }
    return this._ok(out);
  }

  /**
   * Minimal `sed` (issue #26): `-n 'A,Bp'`, `'Ap'`, `'$p'`, `'d'` and
   * `'s/foo/bar/[g]'`, reading stdin (pipelines) or virtual files.
   * @param {string[]} args
   * @param {string|null} stdin
   * @returns {{error:boolean,message:string}}
   */
  _cmd_sed(args, stdin) {
    let quiet = false;
    let inPlace = null;
    const scripts = [];
    const files = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '-n' || arg === '--quiet' || arg === '--silent') {
        quiet = true;
        continue;
      }
      if (arg === '-e' || arg === '--expression') {
        scripts.push(String(args[++index] ?? ''));
        continue;
      }
      if (arg === '-E' || arg === '-r' || arg === '--regexp-extended') continue; // same subset
      // GNU `-i[SUFFIX]` / `--in-place[=SUFFIX]` (1.16.0): edit files in place.
      if (arg === '-i' || arg === '--in-place') {
        inPlace = '';
        continue;
      }
      if (/^-i\S+$/.test(arg)) {
        inPlace = arg.slice(2);
        continue;
      }
      if (arg.startsWith('--in-place=')) {
        inPlace = arg.slice(11);
        continue;
      }
      if (/^-[nEr]+i?$/.test(arg)) {
        if (arg.includes('n')) quiet = true;
        if (arg.endsWith('i')) inPlace = '';
        continue;
      }
      if (arg === '--') {
        for (const rest of args.slice(index + 1)) files.push(rest);
        break;
      }
      if (arg.startsWith('-') && arg !== '-') {
        return this._err(
          `sed: unsupported option '${arg}' (simulator supports: sed [-n] [-i] [-e script] [script] [file ...])`
        );
      }
      if (!scripts.length && !files.length) scripts.push(arg);
      else files.push(arg);
    }
    let commands;
    try {
      commands = parseSedScript(scripts.join('\n'));
    } catch (error) {
      return this._err(
        `sed: -e expression #1, char 1: ${error && error.message ? error.message : error}`
      );
    }
    const transform = (text) => {
      const lines = String(text).split('\n');
      const trailingNewline = lines.length > 1 && lines[lines.length - 1] === '';
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      const output = [];
      lines.forEach((line, index) => {
        const lineNumber = index + 1;
        let pattern = line;
        let deleted = false;
        for (const command of commands) {
          const applies = sedAddressMatches(command.address, lineNumber, lines.length, pattern);
          if (!applies) continue;
          if (command.type === 'print') {
            output.push(pattern);
            continue;
          }
          if (command.type === 'delete') {
            deleted = true;
            break;
          }
          if (command.type === 'substitute') {
            const global = command.global === true;
            const regex = global
              ? new RegExp(command.regex.source, `${command.regex.flags.replace('g', '')}g`)
              : command.regex;
            const next = pattern.replace(regex, sedReplacementString(command.replacement));
            const changed = next !== pattern || regex.test(pattern);
            pattern = next;
            if (command.printAfter && changed) output.push(pattern);
          }
        }
        if (!deleted && !quiet) output.push(pattern);
      });
      return { text: output.join('\n'), trailingNewline };
    };
    if (inPlace !== null) {
      if (!files.length) return this._err('sed: no input files');
      for (const file of files) {
        const read = this._readFileResult(file);
        if (!read.ok) {
          return this._err(`sed: can't read ${file}: ${errnoText(read.error)}`);
        }
        // GNU sed -i writes a temporary file next to the original, then renames it: the
        // DIRECTORY must be writable (not the file), exactly like the real failure.
        const dir = this.host.stat(read.path.replace(/\/[^/]*$/, '') || '/', { user: 'root' });
        const ident = this.host.identity(this._user());
        if (dir.ok && !this.host._can(dir.node, ident, 3)) {
          const suffix = fakeTempSuffix(read.path);
          return this._err(
            `sed: couldn't open temporary file ${read.path.replace(/\/[^/]*$/, '')}/sed${suffix}: Permission denied`
          );
        }
        const result = transform(read.content);
        if (inPlace)
          this.host.writeFile(`${read.path}${inPlace}`, read.content, { user: this._user() });
        const node = this.host.stat(read.path, { user: 'root' }).node;
        this.host._setContent(read.path, node, result.text + (result.trailingNewline ? '\n' : ''));
      }
      this._refreshFilesPanel();
      return this._ok('');
    }
    let input;
    if (files.length) {
      const chunks = [];
      for (const file of files) {
        const read = this._readFileResult(file);
        if (!read.ok) return this._err(`sed: can't read ${file}: ${errnoText(read.error)}`);
        chunks.push(read.content);
      }
      input = chunks.join('\n');
    } else {
      input = stdin === null || stdin === undefined ? '' : String(stdin);
    }
    return this._ok(transform(input).text);
  }

  // ── editing / filesystem ─────────────────────────────────────────────────

  _cmd_vim(args) {
    return this._openEditor(args, 'vim');
  }

  _cmd_vi(args) {
    return this._openEditor(args, 'vi');
  }

  // 1.16.0: ls, rm, touch, cp, mv, pwd, which, the editor (`_openEditor`) and every other
  // RHEL workstation command live in js/ui/LinuxCommands.js (mixed in below the class).

  _cmd_env() {
    return this._ok(
      Object.entries(this.exportedEnvironment())
        .map(([name, value]) => `${name}=${value}`)
        .join('\n')
    );
  }

  _cmd_printenv(args) {
    const names = (args || []).filter((name) => name && !String(name).startsWith('-'));
    const environment = this.exportedEnvironment();
    if (!names.length) return this._cmd_env();
    const found = [];
    let missing = false;
    for (const name of names) {
      if (Object.prototype.hasOwnProperty.call(environment, name))
        found.push(String(environment[name]));
      else missing = true;
    }
    if (missing) {
      // Real printenv exits 1 for an unknown variable without printing an error.
      return { error: true, message: found.join('\n'), silentFailure: found.length === 0 };
    }
    return this._ok(found.join('\n'));
  }

  /** Shell builtin `unset NAME` — removes a variable exported this session (#50). */
  _cmd_unset(args) {
    for (const name of args || []) {
      if (String(name).startsWith('-')) continue;
      this.env.delete(String(name));
      this.vars.delete(String(name));
    }
    return this._ok('');
  }

  /** Shell builtins `true` / `false` keep the `&&` / `||` grammar honest. */
  _cmd_true() {
    return this._ok('');
  }

  _cmd_false() {
    return { error: true, message: '', silentFailure: true };
  }

  /**
   * `export NAME=value` (issue #50): silent on success, persists in the page
   * session / terminal and is usable by `$NAME` / `${NAME}` in later commands.
   */
  _cmd_export(args) {
    if (!args.length) {
      const environment = this.exportedEnvironment();
      return this._ok(
        Object.entries(environment)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, value]) => `declare -x ${name}="${value}"`)
          .join('\n')
      );
    }
    const lines = [];
    for (const arg of args) {
      const equals = String(arg).indexOf('=');
      const name = String(equals < 0 ? arg : arg.slice(0, equals)).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        lines.push(`bash: export: \`${arg}': not a valid identifier`);
        continue;
      }
      // `export NAME` exports the variable's current value (`PATH=…; export PATH`).
      const current = this.vars.has(name)
        ? this.vars.get(name)
        : this.env.has(name)
          ? this.env.get(name)
          : (this.exportedEnvironment()[name] ?? '');
      this.env.set(name, equals < 0 ? current : String(arg).slice(equals + 1));
      this.vars.delete(name);
    }
    return lines.length ? this._err(lines.join('\n')) : this._ok('');
  }

  // ── crypto / HTTP tools (issues #32a/#32b/#32c) ─────────────────────────

  _cmd_openssl(args, stdin) {
    const sub = String(args[0] || '').toLowerCase();
    const rest = args.slice(1);
    if (sub === 'rand') return this._opensslRand(rest);
    if (sub === 'req') return this._opensslReq(rest);
    if (sub === 'x509') return this._opensslX509(rest, stdin);
    if (sub === 'genrsa') return this._opensslGenrsa(rest);
    if (sub === 'version') return this._ok('OpenSSL 3.2.2 4 Jun 2024 (simulated)');
    return this._err(
      `openssl: unsupported subcommand "${sub || ''}" (simulator supports: openssl rand, openssl req -x509, openssl x509, openssl genrsa)`
    );
  }

  _opensslRand(args) {
    let mode = 'hex';
    let length = 16;
    for (const arg of args) {
      if (arg === '-hex' || arg === '-base64') mode = arg.slice(1);
      else if (/^\d+$/.test(arg)) length = Math.min(1024, Number(arg));
    }
    let output = '';
    let counter = 0;
    while (output.length < length * 2) {
      const seed = `${Date.now()}-${counter++}-${Math.random()}`;
      output += fnv1aUint(seed).toString(16).padStart(8, '0');
    }
    if (mode === 'hex') return this._ok(output.slice(0, length * 2));
    const bytes = [];
    for (let index = 0; index < output.length; index += 2) {
      bytes.push(Number.parseInt(output.slice(index, index + 2), 16));
    }
    return this._ok(bytesToBase64(bytes));
  }

  _writeGeneratedFile(path, content) {
    const written = this._writeFile(path, content);
    if (written && written.error) return written;
    return null;
  }

  /** `openssl req -x509 -newkey rsa:2048 -nodes -keyout tls.key -out tls.crt -days 365 -subj "/CN=…"` */
  _opensslReq(args) {
    const options = {
      x509: false,
      nodes: false,
      newkey: null,
      keyout: null,
      out: null,
      days: 365,
      subj: null,
      addext: [],
      bits: 2048,
    };
    const valueFlags = new Set([
      '-newkey',
      '-keyout',
      '-out',
      '-days',
      '-subj',
      '-addext',
      '-config',
      '-passin',
      '-passout',
      '-key',
      '-in',
      '-extensions',
      '-nameopt',
    ]);
    const boolFlags = new Set([
      '-x509',
      '-new',
      '-nodes',
      '-noenc',
      '-sha256',
      '-sha384',
      '-sha512',
      '-batch',
      '-quiet',
      '-help',
      '--help',
    ]);
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '-help' || arg === '--help') {
        return this._ok(
          'openssl req -x509 -newkey rsa:2048 -nodes -keyout <key> -out <cert> -days <n> -subj "/CN=<host>"'
        );
      }
      if (arg === '-nodes' || arg === '-noenc') {
        options.nodes = true;
        continue;
      }
      if (arg === '-x509') {
        options.x509 = true;
        continue;
      }
      if (boolFlags.has(arg)) continue; // -new/-sha256/... accepted and irrelevant for self-signed
      if (valueFlags.has(arg)) {
        const value = args[++index] ?? '';
        if (arg === '-newkey') options.newkey = value;
        else if (arg === '-keyout') options.keyout = value;
        else if (arg === '-out') options.out = value;
        else if (arg === '-days') options.days = value;
        else if (arg === '-subj') options.subj = value;
        else if (arg === '-addext') options.addext.push(value);
        continue;
      }
      return this._err(
        `openssl: unknown option "${arg}"\n\n  openssl req -x509 -newkey rsa:2048 -nodes -keyout <key> -out <cert> -days <n> -subj "/CN=<host>"`
      );
    }
    const usage =
      'openssl req: the simulator creates self-signed certificates only\n\n' +
      '  openssl req -x509 -newkey rsa:2048 -nodes -keyout tls.key -out tls.crt -days 365 -subj "/CN=<host>"';
    if (!options.x509) return this._err(usage);
    const newkeyMatch = String(options.newkey || '').match(/^([a-z0-9]+)(?::(\d+))?$/);
    if (!newkeyMatch) return this._err(usage);
    if (newkeyMatch[1] !== 'rsa') {
      return this._err(`openssl: only "-newkey rsa[:bits]" is simulated (got "${options.newkey}")`);
    }
    if (newkeyMatch[2]) options.bits = Math.min(4096, Math.max(1024, Number(newkeyMatch[2])));
    const subjectAttributes = parseSubjectString(options.subj || '');
    if (!subjectAttributes.commonName) {
      return this._err(
        'openssl req: no common name (interactive prompts are not simulated)\n\n  ... -subj "/CN=<host>"'
      );
    }
    const dnsNames = [subjectAttributes.commonName];
    const ipAddresses = [];
    for (const extension of options.addext) {
      const match = String(extension).match(/^(?:subjectAltName|SAN)\s*=\s*(.+)$/i);
      if (!match) continue;
      for (const entry of match[1].split(',')) {
        const trimmed = entry.trim();
        const dns = trimmed.match(/^DNS\s*:\s*(.+)$/i);
        if (dns) dnsNames.push(dns[1].trim());
        const ip = trimmed.match(/^IP\s*:\s*(.+)$/i);
        if (ip) ipAddresses.push(ip[1].trim());
      }
    }
    const material = createSelfSignedCertificate({
      commonName: subjectAttributes.commonName,
      // Issue #43: the leaf subject must match `-subj` exactly — only carry
      // O (or any other RDN) when the CSR/subject actually requested it (null
      // disables the certificate factory's default `O = OpenShift Games`).
      organization: subjectAttributes.organization ?? null,
      organizationalUnit: subjectAttributes.organizationalUnit,
      country: subjectAttributes.country,
      state: subjectAttributes.state,
      locality: subjectAttributes.locality,
      days: Number(options.days) || 365,
      bits: options.bits,
      sans: { dns: [...new Set(dnsNames)], ip: ipAddresses },
    });
    const lines = ['Generating a RSA private key', '...........+++++'];
    if (!options.nodes) {
      lines.push(
        'warning: interactive passphrase prompts are not simulated; writing an unencrypted key'
      );
    }
    if (options.keyout) {
      const failed = this._writeGeneratedFile(options.keyout, material.keyPem);
      if (failed) return failed;
      lines.push(`writing new private key to '${options.keyout}'`, '-----');
    } else {
      lines.push(material.keyPem.replace(/\n$/, ''));
    }
    if (options.out) {
      const failed = this._writeGeneratedFile(options.out, material.certPem);
      if (failed) return failed;
    } else {
      lines.push(material.certPem.replace(/\n$/, ''));
    }
    return this._ok(lines.join('\n'));
  }

  /** `openssl genrsa [-out tls.key] [bits]` */
  _opensslGenrsa(args) {
    let out = null;
    let bits = 2048;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '-out') {
        out = args[++index] ?? null;
        continue;
      }
      if (/^\d+$/.test(arg)) bits = Math.min(4096, Math.max(1024, Number(arg)));
    }
    const material = generateRsaKeyMaterial(bits);
    const pem = buildPrivateKeyPem(material);
    const lines = [`Generating RSA private key, ${material.bits} bit long modulus (simulated)`];
    if (out) {
      const failed = this._writeGeneratedFile(out, pem);
      if (failed) return failed;
      lines.push(`writing new private key to '${out}'`);
    } else {
      lines.push(pem.replace(/\n$/, ''));
    }
    return this._ok(lines.join('\n'));
  }

  /** `openssl x509 -in tls.crt -noout -text|-subject|-dates|-issuer|-serial|-ext <name>` */
  _opensslX509(args, stdin) {
    const selectors = new Set();
    const options = { in: null, noout: false, extensions: [] };
    const valueFlags = new Set(['-in', '-ext', '-nameopt', '-fingerprint', '-digest']);
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '-help' || arg === '--help') {
        return this._ok(
          'openssl x509 -in <cert> -noout -text|-subject|-issuer|-dates|-startdate|-enddate|-serial'
        );
      }
      if (arg === '-in') {
        options.in = args[++index] ?? null;
        continue;
      }
      if (arg === '-ext') {
        options.extensions.push(String(args[++index] ?? ''));
        continue;
      }
      if (arg === '-noout') {
        options.noout = true;
        continue;
      }
      if (
        arg === '-text' ||
        arg === '-subject' ||
        arg === '-issuer' ||
        arg === '-dates' ||
        arg === '-serial' ||
        arg === '-startdate' ||
        arg === '-enddate'
      ) {
        selectors.add(arg.slice(1));
        continue;
      }
      if (valueFlags.has(arg)) {
        index += 1;
        continue;
      }
      if (arg.startsWith('-')) continue; // -nameopt/-sha256/... accepted
      return this._err(`openssl: unexpected argument "${arg}"`);
    }
    let pem = null;
    if (options.in) {
      pem = this._readFile(options.in);
      if (pem === null) {
        return this._err(`openssl: Could not open certificate file "${options.in}"`);
      }
    } else if (stdin !== null && stdin !== undefined) {
      pem = String(stdin);
    }
    if (!pem) {
      return this._err('openssl x509: no certificate input specified (use -in <file>)');
    }
    const info = parseCertificatePem(pem);
    if (!info)
      return this._err('openssl: unable to load certificate (not a PEM X.509 certificate)');
    const lines = [];
    if (!options.noout) lines.push(String(pem).replace(/\n+$/, ''));
    if (selectors.has('subject')) lines.push(`subject=${formatDistinguishedName(info.subject)}`);
    if (selectors.has('issuer')) lines.push(`issuer=${formatDistinguishedName(info.issuer)}`);
    if (selectors.has('serial')) {
      lines.push(`serial=${info.serial.replace(/:/g, '').toUpperCase()}`);
    }
    if (selectors.has('dates')) {
      lines.push(`notBefore=${formatCertificateDate(info.notBefore)}`);
      lines.push(`notAfter=${formatCertificateDate(info.notAfter)}`);
    }
    // Issue #43: `openssl x509 -noout -enddate` must print
    // `notAfter=<Mon DD HH:MM:SS YYYY GMT>` (and -startdate → notBefore).
    if (selectors.has('startdate') && !selectors.has('dates')) {
      lines.push(`notBefore=${formatCertificateDate(info.notBefore)}`);
    }
    if (selectors.has('enddate') && !selectors.has('dates')) {
      lines.push(`notAfter=${formatCertificateDate(info.notAfter)}`);
    }
    if (selectors.has('text')) lines.push(...this._certificateTextLines(info));
    for (const extension of options.extensions) {
      lines.push(...this._certificateExtensionLines(info, extension));
    }
    return this._ok(lines.join('\n'));
  }

  _certificateTextLines(info) {
    const lines = [
      'Certificate:',
      '    Data:',
      `        Version: ${info.version} (0x${(info.version - 1).toString(16)})`,
    ];
    lines.push('        Serial Number:', `            ${info.serial}`);
    lines.push(`        Signature Algorithm: ${info.signatureAlgorithm}`);
    lines.push(`        Issuer: ${formatDistinguishedName(info.issuer)}`);
    lines.push('        Validity');
    lines.push(`            Not Before: ${formatCertificateDate(info.notBefore)}`);
    lines.push(`            Not After : ${formatCertificateDate(info.notAfter)}`);
    lines.push(`        Subject: ${formatDistinguishedName(info.subject)}`);
    lines.push('        Subject Public Key Info:');
    lines.push('            Public Key Algorithm: rsaEncryption');
    lines.push(`                Public-Key: (${info.publicKeyBits} bit)`);
    if (info.modulus && info.modulus.length) {
      lines.push('                Modulus:');
      for (let offset = 0; offset < info.modulus.length; offset += 16) {
        lines.push(
          `                    ${bytesToHex(info.modulus.slice(offset, offset + 16), ':')}`
        );
      }
    }
    if (info.exponent) {
      lines.push(`                Exponent: ${info.exponent} (0x${info.exponent.toString(16)})`);
    }
    if (info.sans.length || info.isCA) {
      lines.push('        X509v3 extensions:');
      if (info.sans.length) {
        lines.push('            X509v3 Subject Alternative Name:');
        lines.push(
          `                ${info.sans.map((name) => (name.includes(':') ? `IP Address:${name}` : `DNS:${name}`)).join(', ')}`
        );
      }
      if (info.isCA) {
        lines.push('            X509v3 Basic Constraints: critical');
        lines.push('                CA:TRUE');
      }
    }
    lines.push(`    Signature Algorithm: ${info.signatureAlgorithm}`);
    for (let offset = 0; offset < info.signatureBytes.length; offset += 18) {
      lines.push(`         ${bytesToHex(info.signatureBytes.slice(offset, offset + 18), ':')}`);
    }
    return lines;
  }

  _certificateExtensionLines(info, extension) {
    const name = String(extension || '')
      .trim()
      .toLowerCase();
    if (name === 'subjectaltname' || name === 'san') {
      const values = info.sans.map((entry) =>
        entry.includes(':') ? `IP Address:${entry}` : `DNS:${entry}`
      );
      return ['X509v3 Subject Alternative Name: ', `    ${values.join(', ') || '<none>'}`];
    }
    if (name === 'basicconstraints') {
      return ['X509v3 Basic Constraints: critical', `    CA:${info.isCA ? 'TRUE' : 'FALSE'}`];
    }
    return [`X509v3 extension "${extension}": not present`];
  }

  // ── base64 (issue #32a) ────────────────────────────────────────────────

  /**
   * GNU-style `base64` (issue #32a): encode stdin/files, or `-d`/`--decode`
   * stdin/files. Decoding is the standard way to read a Secret value:
   * `oc get secret db-secret -o jsonpath={.data.password} | base64 -d`.
   */
  _cmd_base64(args, stdin) {
    let decode = false;
    let wrap = 76;
    let ignoreGarbage = false;
    const files = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '-d' || arg === '--decode') {
        decode = true;
        continue;
      }
      if (arg === '-i' || arg === '--ignore-garbage') {
        ignoreGarbage = true;
        continue;
      }
      if (arg === '-w' || arg === '--wrap') {
        const value = Number.parseInt(args[++index] ?? '', 10);
        wrap = Number.isFinite(value) ? Math.max(0, value) : 76;
        continue;
      }
      if (/^-w\d+$/.test(arg)) {
        wrap = Number.parseInt(arg.slice(2), 10);
        continue;
      }
      if (/^--wrap=\d+$/.test(arg)) {
        wrap = Number.parseInt(arg.slice('--wrap='.length), 10);
        continue;
      }
      if (arg === '-h' || arg === '--help') {
        return this._ok(
          'Usage: base64 [OPTION]... [FILE]...\n  -d, --decode          decode data\n  -w, --wrap=COLS       wrap encoded lines after COLS characters (default 76, 0 disables)'
        );
      }
      if (arg === '-' || !arg.startsWith('-')) {
        files.push(arg);
        continue;
      }
      return this._err(`base64: invalid option -- '${arg.slice(1)}'`);
    }
    let input;
    if (files.length) {
      const chunks = [];
      for (const file of files) {
        const content = file === '-' ? (stdin ?? '') : this._readFile(file);
        if (content === null) return this._err(`base64: ${file}: No such file or directory`);
        chunks.push(content);
      }
      input = chunks.join('');
    } else {
      input = stdin === null || stdin === undefined ? '' : String(stdin);
    }
    if (!decode) {
      const encoded = bytesToBase64(textToUtf8Bytes(input));
      if (wrap <= 0) return this._ok(encoded);
      const lines = [];
      for (let index = 0; index < encoded.length; index += wrap) {
        lines.push(encoded.slice(index, index + wrap));
      }
      return this._ok(lines.join('\n'));
    }
    const raw = String(input);
    const compact = raw.replace(/\s+/g, '');
    if (!ignoreGarbage) {
      const invalid = compact.match(/[^A-Za-z0-9+/=]/);
      if (invalid) return this._err('base64: invalid input');
    }
    const clean = compact.replace(/[^A-Za-z0-9+/=]/g, '');
    if (!clean) return this._ok('');
    if (clean.length % 4 === 1) return this._err('base64: invalid input');
    const padded = clean.endsWith('=')
      ? clean
      : clean.padEnd(clean.length + ((4 - (clean.length % 4)) % 4), '=');
    let bytes;
    try {
      bytes = base64ToBytes(padded);
    } catch {
      return this._err('base64: invalid input');
    }
    return this._ok(utf8BytesToText(bytes));
  }

  // ── curl from the workstation (issue #32c) ─────────────────────────────

  /** Run one workstation HTTP(S) request through the simulated router. */
  _workstationCurl(rawUrl, options = {}) {
    const sim = this.bar?.gameEngine?.simulation;
    if (!sim || typeof sim.trafficForWorkstationCurl !== 'function') {
      return { error: { code: 6, message: `Could not resolve host: ${options.host || rawUrl}` } };
    }
    return sim.trafficForWorkstationCurl(rawUrl, options);
  }

  /**
   * The exam workstation is an internet-connected machine, so well-known public
   * hosts answer like the real internet instead of failing with a DNS error
   * (#49). Only the IANA example domains are modelled — their content is stable
   * and `curl https://example.com` is the canonical connectivity smoke test —
   * while every other external host stays outside the sandbox's DNS and reports
   * the real `curl: (6) Could not resolve host: …` failure.
   * @param {{scheme: string, hostname: string, port: (number|null), path: string}} parsed
   * @returns {object|null} a `trafficForWorkstationCurl`-shaped response
   */
  _simulatedInternetCurl(parsed) {
    const host = String(parsed?.hostname || '').toLowerCase();
    if (!SIMULATED_INTERNET_HOSTS.has(host)) return null;
    // A Route that actually claims this host in the simulated cluster wins over
    // the canned internet reply (the router must answer for its own hosts).
    const cluster = this.bar?.gameEngine?.cluster;
    if (cluster && typeof cluster.getRouteHost === 'function') {
      const claimed = (cluster.getByKind?.('Route') || []).some(
        (route) => String(cluster.getRouteHost(route) || '').toLowerCase() === host
      );
      if (claimed) return null;
    }
    return {
      scheme: parsed.scheme,
      host,
      port: parsed.port || (parsed.scheme === 'https' ? 443 : 80),
      path: parsed.path || '/',
      status: 200,
      statusText: 'OK',
      serverIp: '93.184.216.34',
      headers: {
        'content-type': 'text/html; charset=utf-8',
        server: 'cloudflare',
        'last-modified': 'Wed, 04 Nov 2026 18:12:44 GMT',
        'cache-control': 'max-age=86000',
      },
      body: SIMULATED_INTERNET_HTML,
      serverCert:
        parsed.scheme === 'https'
          ? {
              trusted: true,
              selfSigned: false,
              commonName: 'example.com',
              sans: ['example.com', '*.example.com'],
              subject: { commonName: 'example.com' },
              issuer: { commonName: 'DigiCert Global G3 TLS RSA SHA256 2020 CA1' },
            }
          : null,
    };
  }

  _certificateMatchesHost(certificate, host) {
    const target = String(host || '')
      .toLowerCase()
      .replace(/\.$/, '');
    const candidates = [certificate?.commonName, ...(certificate?.sans || [])]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
    return candidates.some((name) => {
      if (!name) return false;
      if (name === target) return true;
      if (!name.startsWith('*.')) return false;
      const suffix = name.slice(1); // ".apps.cluster.example.com"
      if (!target.endsWith(suffix)) return false;
      const prefix = target.slice(0, target.length - suffix.length);
      return prefix.length > 0 && !prefix.includes('.');
    });
  }

  /** Plain `curl: (N) message` failure line. */
  _curlFailureLines(code, message) {
    return [`curl: (${code}) ${message}`];
  }

  /**
   * Parse curl argv into normalised options + positional URLs. Kept shared by
   * the workstation `curl` and `oc exec … -- curl` so both honour the same
   * real flags (`-s`, `-S`, `-o`, `-w`, `-i`, `-I`, `-k`, `-L`, `-X`, …).
   */
  _parseCurlOptions(args) {
    const options = {
      insecure: false,
      silent: false,
      showError: false,
      include: false,
      head: false,
      follow: false,
      verbose: false,
      fail: false,
      output: null,
      cacert: null,
      method: null,
      writeOut: null,
      maxTime: null,
      /** Custom request headers, lowercase name → value (last `-H` wins). */
      headers: {},
    };
    /** Record one `-H/--header 'Name: value'` argument. */
    const setHeader = (value) => {
      const text = String(value ?? '');
      const colon = text.indexOf(':');
      if (colon <= 0) return;
      options.headers[text.slice(0, colon).trim().toLowerCase()] = text.slice(colon + 1).trim();
    };
    const urls = [];
    const shortValueFlags = new Set([
      '-o',
      '-H',
      '-X',
      '-A',
      '-w',
      '-m',
      '-d',
      '-F',
      '-u',
      '-b',
      '-e',
      '-x',
      '-r',
      '-E',
      '-T',
    ]);
    const longValueFlags = new Set([
      '--output',
      '--header',
      '--request',
      '--user-agent',
      '--write-out',
      '--max-time',
      '--connect-timeout',
      '--data',
      '--data-raw',
      '--data-binary',
      '--form',
      '--user',
      '--cookie',
      '--cookie-jar',
      '--referer',
      '--proxy',
      '--cert',
      '--key',
      '--cacert',
      '--capath',
      '--resolve',
      '--retry',
      '--retry-delay',
      '--limit-rate',
      '--interface',
      '--url',
    ]);
    const booleanLongFlags = new Set([
      '--insecure',
      '--silent',
      '--show-error',
      '--include',
      '--head',
      '--location',
      '--location-trusted',
      '--verbose',
      '--fail',
      '--fail-with-body',
      '--compressed',
      '--http1.1',
      '--http2',
      '--tlsv1.2',
      '--tlsv1.3',
      '--globoff',
      '--noproxy',
      '--raw',
    ]);
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (longValueFlags.has(arg)) {
        const value = args[++index] ?? '';
        if (arg === '--output') options.output = value;
        else if (arg === '--cacert') options.cacert = value;
        else if (arg === '--request') options.method = value.toUpperCase();
        else if (arg === '--write-out') options.writeOut = value;
        else if (arg === '--header') setHeader(value);
        else if (arg === '--max-time' || arg === '--connect-timeout')
          options.maxTime = Number(value) || null;
        else if (arg === '--url') urls.push(value);
        continue;
      }
      if (booleanLongFlags.has(arg)) {
        if (arg === '--insecure') options.insecure = true;
        else if (arg === '--silent') options.silent = true;
        else if (arg === '--show-error') options.showError = true;
        else if (arg === '--include') options.include = true;
        else if (arg === '--head') options.head = true;
        else if (arg === '--location' || arg === '--location-trusted') options.follow = true;
        else if (arg === '--verbose') options.verbose = true;
        else if (arg === '--fail' || arg === '--fail-with-body') options.fail = true;
        continue;
      }
      if (arg.startsWith('--')) {
        // Unknown long flag: accept and ignore (curl-style forward compatibility).
        const eq = arg.indexOf('=');
        if (eq < 0 && args[index + 1] && !args[index + 1].startsWith('-')) index += 1;
        continue;
      }
      if (shortValueFlags.has(arg)) {
        const value = args[++index] ?? '';
        if (arg === '-o') options.output = value;
        else if (arg === '-X') options.method = value.toUpperCase();
        else if (arg === '-w') options.writeOut = value;
        else if (arg === '-m') options.maxTime = Number(value) || null;
        else if (arg === '-H') setHeader(value);
        continue;
      }
      if (arg.startsWith('-') && arg.length > 1) {
        for (const flag of arg.slice(1)) {
          if (flag === 'k') options.insecure = true;
          else if (flag === 's') options.silent = true;
          else if (flag === 'S') options.showError = true;
          else if (flag === 'i') options.include = true;
          else if (flag === 'I') options.head = true;
          else if (flag === 'L') options.follow = true;
          else if (flag === 'v') options.verbose = true;
          else if (flag === 'f') options.fail = true;
        }
        continue;
      }
      urls.push(arg);
    }
    return { options, urls };
  }

  /**
   * Expand a curl `--write-out` format. Values are looked up case-sensitively
   * in `values`; `%%` is a literal `%`. Escape support covers `\n`, `\t`,
   * `\r` and `\\` (single-quoted formats keep the backslash through the
   * tokenizer, e.g. `-w '%{http_code}\n'`). Unknown `%{variables}` are left
   * as-is, like curl printing the literal for variables it does not know.
   */
  _curlWriteOutText(options, values = {}) {
    const format = options ? options.writeOut : null;
    if (format === null || format === undefined || format === '') return '';
    const marker = '\u0000';
    let text = String(format).replace(/%%/g, marker);
    text = text.replace(/%\{([A-Za-z0-9_.-]+)\}/g, (match, key) => {
      if (Object.prototype.hasOwnProperty.call(values, key)) return String(values[key] ?? '');
      return match;
    });
    text = text.replace(/\\([ntr\\])/g, (match, escape) => {
      const map = { n: '\n', t: '\t', r: '\r', '\\': '\\' };
      return map[escape] ?? match;
    });
    return text.split(marker).join('%');
  }

  /** Classify a curl `-o/--output` target: discard, stdout, or a real file. */
  _curlOutputTarget(path) {
    if (path === null || path === undefined || path === '') return null;
    const raw = String(path);
    if (raw === '/dev/null' || raw === '/dev/zero') return 'discard';
    if (raw === '-' || raw === '/dev/stdout') return 'stdout';
    return 'file';
  }

  /**
   * Join the curl response + `--write-out` output the way the real tool writes
   * stdout: response bytes first (unless `-o`), then the expanded format with
   * no implicit newline.
   */
  _curlComposeOutput(options, { responseText = '', writeOutValues = {}, writeFile = null } = {}) {
    const target = options.output ? this._curlOutputTarget(options.output) : null;
    if (target === 'file' && typeof writeFile === 'function') {
      const failure = writeFile(responseText);
      if (failure) return failure;
    }
    const writeOut = this._curlWriteOutText(options, writeOutValues);
    if (target === 'discard' || target === 'file') return this._ok(writeOut);
    return this._ok(responseText + writeOut);
  }

  /** Values exposed to `--write-out` for a completed request. */
  _curlWriteOutValues({
    url,
    scheme,
    host,
    port,
    status,
    headers = {},
    body = '',
    redirects = 0,
    serverIp = '',
  } = {}) {
    const code = String(Number(status) || 0).padStart(3, '0');
    return {
      http_code: code,
      response_code: code,
      url_effective: String(url || ''),
      scheme: String(scheme || ''),
      remote_ip: String(serverIp || ''),
      remote_port: String(port || ''),
      num_redirects: String(redirects || 0),
      time_total: '0.001',
      size_download: String(String(body || '').length),
      content_type: String(headers['content-type'] || headers['Content-Type'] || '')
        .split(';')[0]
        .trim(),
      redirect_url: String(headers.location || ''),
      ssl_verify_result: '0',
      exitcode: '0',
      errormsg: '',
    };
  }

  /** Normalise a simulated failure into real curl's code/message shapes. */
  _normalizeCurlError(error, options = {}) {
    const code = Number(error && error.code) || 7;
    const message = String((error && error.message) || 'Failed to connect');
    const timeoutMs = Number(options.maxTime) > 0 ? Number(options.maxTime) * 1000 : 30000;
    const timedOut =
      (error && error.timedOut === true) ||
      code === 28 ||
      (code === 7 && /tim(e|ed)?[ -]?out|timeout/i.test(message));
    if (timedOut)
      return { code: 28, message: `Connection timed out after ${timeoutMs} milliseconds` };
    return { code, message };
  }

  /**
   * A direct `curl: (N) message` failure that never reached the network, with
   * curl's real exit status (a failed command's status is its error code).
   */
  _curlError(code, message) {
    const result = this._err(`curl: (${code}) ${message}`);
    result.exitCode = code;
    return result;
  }

  /**
   * Render a failed curl request: `-s` silences error messages unless `-S`,
   * while `--write-out` still runs (real curl prints it even on failure).
   */
  _curlFailureOutput(options, error, { lines = [], detailLines = null, writeOutValues = {} } = {}) {
    const normalized = this._normalizeCurlError(error, options);
    const showError = !options.silent || options.showError || options.verbose;
    const allLines = [...lines];
    if (showError) {
      if (detailLines && detailLines.length) allLines.push(...detailLines);
      else allLines.push(...this._curlFailureLines(normalized.code, normalized.message));
    }
    const writeOut = this._curlWriteOutText(options, {
      ...writeOutValues,
      http_code: '000',
      response_code: '000',
      exitcode: String(normalized.code),
      errormsg: normalized.message,
      size_download: '0',
    });
    const text = allLines.join('\n') + (allLines.length && writeOut ? '\n' : '') + writeOut;
    const result = this._err(text);
    // Real curl exits with the error code itself (e.g. 6/7/28/35/60), which
    // `$?`/`&&`/`||` must observe; a TLS handshake failure is exit 35 (#75).
    result.exitCode = normalized.code;
    // A silent failure (`curl -s`) has no output at all; the shell must not
    // replace it with the generic `error: command failed` fallback (#49).
    result.silentFailure = text === '';
    return result;
  }

  /**
   * Workstation `curl` (issue #32c): resolves Route hosts through the simulated
   * router, honouring edge/passthrough/re-encrypt TLS, the http→https redirect
   * policy and router→Service NetworkPolicy reachability. Issue #43 fidelity:
   * `-s`, `-o /dev/null`, `-w "%{http_code}"`, scheme-default ports.
   */
  _cmd_curl(args) {
    const { options, urls } = this._parseCurlOptions(args);
    if (!urls.length) {
      const result = this._err(
        "curl: no URL specified!\ncurl: try 'curl --help' or 'curl --manual' for more information"
      );
      result.exitCode = 2; // real curl's "no URL specified" exit status
      return result;
    }
    let url = urls[0];
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
    const maxRedirects = 5;
    const requestLines = [];
    let redirects = 0;
    let result = null;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const parsed = this._parseCurlUrl(url);
      if (parsed.error) return this._curlError(3, parsed.error);
      if (!['http', 'https'].includes(parsed.scheme)) {
        return this._curlError(1, `Protocol "${parsed.scheme}" not supported`);
      }
      if (!parsed.hostname) {
        return this._curlError(3, 'URL rejected: Malformed input to a URL function');
      }
      // 1.16.0: the workstation's resolver first (/etc/hosts, localhost services, the API
      // endpoint); anything it does not own keeps the router/internet paths below.
      result =
        this._workstationHostCurl(parsed, options) ||
        this._simulatedInternetCurl(parsed) ||
        this._workstationCurl(url, {
          method: options.head ? 'HEAD' : options.method || 'GET',
          insecure: options.insecure,
        });
      if (!result || result.error) break;
      const status = Number(result.status || 0);
      const location = result.location;
      if (options.follow && location && status >= 300 && status < 400) {
        if (hop >= maxRedirects) {
          return this._curlError(47, 'Maximum (5) redirects followed');
        }
        redirects += 1;
        if (options.verbose)
          requestLines.push(`* Issue another request to this URL: '${location}'`);
        url = location;
        continue;
      }
      break;
    }
    const parsedUrl = this._parseCurlUrl(url);
    const scheme = (result && result.scheme) || parsedUrl.scheme || 'http';
    const host = (result && result.host) || parsedUrl.hostname || '';
    const port = (result && result.port) || parsedUrl.port || (scheme === 'https' ? 443 : 80);
    const writeOutValues = this._curlWriteOutValues({
      url,
      scheme,
      host,
      port,
      status: result && result.status,
      headers: (result && result.headers) || {},
      body: (result && result.body) || '',
      redirects,
      serverIp: (result && result.serverIp) || '',
    });
    if (result && result.error) {
      if (options.verbose) requestLines.push(`*   Trying ${host}:${port}...`);
      return this._curlFailureOutput(options, result.error, {
        lines: requestLines,
        writeOutValues,
      });
    }
    if (!result) {
      if (options.verbose) requestLines.push(`*   Trying ${host}:${port}...`);
      return this._curlFailureOutput(
        options,
        { code: 7, message: 'Failed to connect' },
        { lines: requestLines, writeOutValues }
      );
    }
    // Real curl prints the connection preamble before a TLS verification
    // failure, so build it up-front and reuse it in both paths.
    const verboseLines = [];
    if (options.verbose) {
      verboseLines.push(`*   Trying ${host}:${port}...`);
      verboseLines.push(
        `* Connected to ${host} (${result.serverIp || '172.30.0.20'}) port ${port}`
      );
      if (scheme === 'https') {
        verboseLines.push('* TLS 1.3 connection using TLS_AES_256_GCM_SHA384');
        verboseLines.push('* Server certificate:');
        verboseLines.push(
          `*  subject: ${formatDistinguishedName(result.serverCert?.subject || {})}`
        );
        verboseLines.push(`*  issuer: ${formatDistinguishedName(result.serverCert?.issuer || {})}`);
      }
      verboseLines.push(
        `> ${options.head ? 'HEAD' : options.method || 'GET'} ${result.path || '/'} HTTP/1.1`
      );
      verboseLines.push(`> Host: ${host}`);
      verboseLines.push('> User-Agent: curl/8.7.1');
      verboseLines.push('> Accept: */*');
      verboseLines.push('>');
    }
    const lines = [];
    if (scheme === 'https' && !options.insecure) {
      const certificate = result.serverCert;
      if (!certificate) {
        return this._curlFailureOutput(
          options,
          { code: 60, message: 'SSL certificate problem: unable to get local issuer certificate' },
          { lines: [...requestLines, ...verboseLines], writeOutValues }
        );
      }
      if (options.cacert) {
        const ca = this._readFile(options.cacert);
        if (ca === null) {
          return this._curlError(77, `error setting certificate file: ${options.cacert}`);
        }
        if (!parseCertificatePem(ca)) {
          return this._curlError(77, `error setting certificate file: ${options.cacert}`);
        }
      } else if (!certificate.trusted) {
        const problem =
          certificate.problem ||
          (certificate.selfSigned
            ? 'self-signed certificate'
            : 'unable to get local issuer certificate');
        return this._curlFailureOutput(
          options,
          { code: 60, message: `SSL certificate problem: ${problem}` },
          {
            lines: [...requestLines, ...verboseLines],
            detailLines: [
              ...this._curlFailureLines(60, `SSL certificate problem: ${problem}`),
              'More details here: https://curl.se/docs/sslcerts.html',
              '',
              'curl failed to verify the legitimacy of the server and therefore could not',
              'establish a secure connection to it. To learn more about this situation and',
              'how to fix it, please visit the web page mentioned above.',
            ],
            writeOutValues,
          }
        );
      }
      if (!this._certificateMatchesHost(certificate, host)) {
        return this._curlFailureOutput(
          options,
          {
            code: 60,
            message: `SSL: no alternative certificate subject name matches target host name '${host}'`,
          },
          { lines: [...requestLines, ...verboseLines], writeOutValues }
        );
      }
    }
    lines.push(...verboseLines);
    const status = Number(result.status || 0);
    const statusText = result.statusText || '';
    const headers = result.headers || {};
    const showHeaders = options.include || options.head || options.verbose;
    if (showHeaders) {
      if (options.verbose) {
        // Only `curl -v` uses the `< ` direction markers for response headers.
        lines.push(`< HTTP/1.1 ${status} ${statusText}`.trim());
        for (const [name, value] of Object.entries(headers)) {
          lines.push(`< ${name}: ${value}`);
        }
        lines.push('<');
      } else {
        // `-I/--head` and `-i/--include` write the status line and headers to
        // stdout as plain lines followed by the blank header/body separator
        // (#54: they used to leak the verbose `< ` format).
        lines.push(`HTTP/1.1 ${status} ${statusText}`.trim());
        for (const [name, value] of Object.entries(headers)) {
          lines.push(`${name}: ${value}`);
        }
        lines.push('');
      }
    }
    if (options.fail && status >= 400) {
      return this._curlFailureOutput(
        options,
        { code: 22, message: `The requested URL returned error: ${status}` },
        { lines: requestLines, detailLines: lines, writeOutValues }
      );
    }
    const responseLines = [...requestLines, ...lines];
    const bodyText = options.head ? '' : result.body || '';
    return this._curlComposeOutput(options, {
      responseText: [...responseLines, ...(bodyText ? [bodyText] : [])].join('\n'),
      writeOutValues,
      writeFile: (text) => {
        const written = this._writeFile(options.output, text);
        return written && written.error ? written : null;
      },
    });
  }

  /**
   * Render `oc exec <pod> -- curl …` with real curl semantics (issue #43).
   *
   * Reads the same argv as the workstation `curl` but runs the request against
   * the simulated Pod network (`SimulationTick.trafficForExec`). A SYN dropped
   * by a NetworkPolicy is a connection timeout — `curl: (28) Connection timed
   * out after 30000 milliseconds` — while a Service with no endpoints is a real
   * refusal — `curl: (7) … Connection refused`. The URL scheme decides the
   * default port (https → 443, not 80).
   *
   * @param {string[]} args curl argv (the command name already stripped)
   * @param {object} context CommandBar `_podExecContext(pod, containerName)`
   * @returns {{ok: boolean, lines: string[]}}
   */
  runExecCurl(args, context = {}) {
    const { options, urls } = this._parseCurlOptions(args);
    // Keep curl's own exit status (6/7/28/35…): the exec surface prints
    // `command terminated with exit code N` and `&&`/`||` must see it (1.16.0 —
    // a NetworkPolicy-blocked `curl -s` used to exit 0 with no output).
    const asResult = (value) =>
      value.message === ''
        ? { ok: !value.error, lines: [], exitCode: value.exitCode }
        : { ok: !value.error, lines: String(value.message).split('\n'), exitCode: value.exitCode };
    if (!urls.length) {
      return {
        ok: false,
        lines: [
          'curl: no URL specified!',
          "curl: try 'curl --help' or 'curl --manual' for more information",
        ],
      };
    }
    let url = urls[0];
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
    const parsed = this._parseCurlUrl(url);
    if (parsed.error) {
      return { ok: false, lines: ['curl: (3) URL rejected: Malformed input to a URL function'] };
    }
    if (!['http', 'https'].includes(parsed.scheme)) {
      return { ok: false, lines: [`curl: (1) Protocol "${parsed.scheme}" not supported`] };
    }
    if (!parsed.hostname) {
      return { ok: false, lines: ['curl: (3) URL rejected: Malformed input to a URL function'] };
    }
    const port = parsed.port || (parsed.scheme === 'https' ? 443 : 80);
    const sim = this.bar?.gameEngine?.simulation;
    let result = null;
    if (sim && typeof sim.trafficForExec === 'function') {
      result = sim.trafficForExec(context.pod, {
        target: parsed.hostname,
        port,
        scheme: parsed.scheme,
        namespace: context.namespace,
        protocol: 'TCP',
        // Real container name resolved from the workload pod template
        // (`webapp`, not a hardcoded `main`, #54d).
        container: context.containerName,
        // L16 (#76): the in-cluster API-server model needs the request path and
        // headers (`Authorization: Bearer <sa-token>`) to answer with the real
        // PodList / 403 Status JSON instead of the anonymous fallback.
        path: parsed.path || '/',
        headers: options.headers || {},
      });
    }
    /** Real curl exit code for a simulated deny reason (issue #43). */
    const failureFor = () => {
      if (!result) return { code: 6, message: `Could not resolve host: ${parsed.hostname}` };
      if (result.error) return result.error;
      if (result.allowed !== false) return null;
      const reason = String(result.reason || '');
      if (['dns-egress', 'dns', 'target-not-found', 'source-not-found'].includes(reason)) {
        return { code: 6, message: `Could not resolve host: ${parsed.hostname}` };
      }
      if (['no-endpoints', 'service-not-found'].includes(reason)) {
        return {
          code: 7,
          message: `Failed to connect to ${parsed.hostname} port ${port} after 0 ms: Connection refused`,
        };
      }
      if (['egress', 'ingress', 'networkpolicy-drop'].includes(reason)) {
        return { code: 28, message: 'Connection timed out after 30000 milliseconds' };
      }
      return {
        code: 7,
        message: `Failed to connect to ${parsed.hostname} port ${port} after 0 ms: Couldn't connect to server`,
      };
    };
    const writeOutValues = this._curlWriteOutValues({
      url,
      scheme: parsed.scheme,
      host: parsed.hostname,
      port,
      status: result && result.status !== undefined ? result.status : 200,
      headers: (result && result.headers) || {},
      body: ((result && result.lines) || []).join('\n'),
      serverIp: (result && result.serverIp) || '',
    });
    const failure = failureFor();
    // #61 item 4: real curl resolves the name BEFORE it opens a connection. A
    // DNS failure only prints `* Could not resolve host: …`; a connection
    // failure after a resolved name prints `*   Trying host:port...` but never
    // `* Connected` (that line only appears once the request actually works).
    const requestLines = [];
    if (options.verbose) {
      if (failure && Number(failure.code) === 6) {
        requestLines.push(`* Could not resolve host: ${parsed.hostname}`);
      } else {
        requestLines.push(`*   Trying ${parsed.hostname}:${port}...`);
        if (!failure) {
          requestLines.push(`* Connected to ${parsed.hostname} port ${port}`);
          if (parsed.scheme === 'https') {
            requestLines.push('* TLS 1.3 connection using TLS_AES_256_GCM_SHA384');
          }
        }
      }
    }
    if (failure) {
      return asResult(
        this._curlFailureOutput(options, failure, { lines: requestLines, writeOutValues })
      );
    }
    const body = ((result && result.lines) || []).join('\n');
    const showHeaders = options.verbose || options.include || options.head;
    // Same distinction as the workstation curl (#54): `-v` marks response
    // headers with `< `; `-i`/`-I` print plain header lines.
    const headerLines = !showHeaders
      ? []
      : options.verbose
        ? ['< HTTP/1.1 200 OK', '< content-type: text/html; charset=utf-8', '<']
        : ['HTTP/1.1 200 OK', 'content-type: text/html; charset=utf-8', ''];
    const responseText = [
      ...requestLines,
      ...headerLines,
      ...(options.head || !body ? [] : [body]),
    ].join('\n');
    return asResult(
      this._curlComposeOutput(options, {
        responseText,
        writeOutValues,
        writeFile: (text) => this._execCurlWriteFile(options.output, text, context),
      })
    );
  }

  /** Store a curl `-o <file>` response inside the `oc exec` pod filesystem. */
  _execCurlWriteFile(path, text, context = {}) {
    const files = context.files;
    if (!files || typeof files.set !== 'function') return null;
    let normalized = String(path || '');
    if (!normalized.startsWith('/')) normalized = `/${normalized}`;
    files.set(normalized.replace(/\/+/g, '/'), String(text ?? ''));
    return null;
  }

  _parseCurlUrl(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl));
      const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
      return {
        scheme,
        hostname: parsed.hostname,
        // Real curl derives the port from the scheme when the URL omits it:
        // https → 443, http → 80 (issue #43: `curl https://example.com` must
        // not report port 80).
        port: parsed.port
          ? Number(parsed.port)
          : scheme === 'https'
            ? 443
            : scheme === 'http'
              ? 80
              : null,
        explicitPort: Boolean(parsed.port),
        path: `${parsed.pathname || '/'}${parsed.search || ''}`,
      };
    } catch {
      return { error: 'URL rejected: Malformed input to a URL function' };
    }
  }

  _cmd_skopeo(args, stdin) {
    const sub = String(args[0] || '').toLowerCase();
    if (sub === '--version' || sub === '-v') return this._ok('skopeo version 1.18.1');
    if (sub === 'list-tags' && this._skopeoListTags) return this._skopeoListTags(args.slice(1));
    if (sub !== 'inspect') {
      return this._err(
        `FATA[0000] skopeo: unsupported command "${sub || ''}" (simulator supports: skopeo inspect [--format=...] docker://<image>)`
      );
    }
    let format = null;
    const positionals = [];
    for (let i = 1; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === '-f' || arg === '--format') {
        format = args[++i] ?? null;
        continue;
      }
      if (arg.startsWith('--format=')) {
        format = arg.slice('--format='.length);
        continue;
      }
      if (arg.startsWith('-')) continue;
      positionals.push(arg);
    }
    const reference = positionals[0];
    if (!reference) return this._err('FATA[0000] skopeo inspect: no image name given');
    const bare = String(reference)
      .replace(/^docker:\/\//, '')
      .replace(/^oci:\/\//, '');
    // 1.16.0: images of the workstation's registry catalog answer like the registry
    // (one digest per image whatever tag spelling, the real `skopeo inspect` JSON).
    const catalog = this._skopeoCatalogInspect?.(bare, format);
    if (catalog) return catalog;
    const info = this.bar._imageInfoFor(bare, this.bar.currentProject);
    const tag = bare.includes(':') ? bare.split(':').pop() : 'latest';
    const inspect = {
      Name: bare,
      Digest: info.digest,
      RepoTags: [tag],
      Created: info.created,
      DockerVersion: '',
      Labels: info.labels || {},
      Architecture: info.arch,
      Os: info.os,
      Layers: [],
    };
    if (format) {
      // Minimal Go-template support: single-field `{{.Digest}}` style templates.
      const rendered = format.replace(/\{\{\s*\.([A-Za-z0-9_]+)\s*\}\}/g, (match, field) => {
        const value = inspect[field];
        return value === undefined ? match : String(value);
      });
      return this._ok(rendered);
    }
    return this._ok(JSON.stringify(inspect, null, 4));
  }

  _cmd_htpasswd(args, stdin) {
    const result = this.bar._cmdHtpasswd(args);
    if (result && typeof result === 'object')
      return { error: Boolean(result.error), message: String(result.message ?? '') };
    return this._ok(String(result ?? ''));
  }

  // ── terminal control ─────────────────────────────────────────────────────

  _cmd_clear() {
    return { error: false, message: '', clear: true };
  }
}

// The RHEL 9 workstation commands (cd, ls -l, chmod, systemctl, dnf, podman, …) and the
// filesystem/permission-aware replacements of ls/rm/cp/mv/touch/pwd/which/exit/editor.
Object.assign(ShellTools.prototype, LINUX_COMMAND_METHODS);

export default ShellTools;
