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
 *   - commands:            cat, echo, grep, tail, head, wc, vim/vi, sort, uniq,
 *                          cut, tr, ls, rm, cp, mv, touch, pwd, which, env,
 *                          openssl, skopeo, htpasswd (-B forwarded to bcrypt hashing)
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

/** Shell commands recognised without the `oc ` prefix (completion + dispatch). */
export const SHELL_COMMANDS = [
  'cat', 'echo', 'grep', 'tail', 'head', 'wc', 'vim', 'vi', 'sort', 'uniq', 'cut', 'tr',
  'ls', 'rm', 'cp', 'mv', 'touch', 'pwd', 'which', 'env', 'printenv', 'openssl', 'skopeo',
  'htpasswd', 'clear', 'exit',
];

/** Commands that take file paths (Tab completion / suggestion hints). */
export const SHELL_FILE_COMMANDS = new Set(['cat', 'vim', 'vi', 'head', 'tail', 'wc', 'grep', 'rm', 'source']);

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

function countWords(text) {
  return String(text || '')
    .split(/\s+/)
    .filter(Boolean).length;
}

export class ShellTools {
  /**
   * @param {import('./CommandBar.js').default} bar the owning CommandBar
   */
  constructor(bar) {
    this.bar = bar;
    this.cwd = '/';
    /** Last command exit code / status, exposed for teaching hints. */
    this.lastExitCode = 0;
  }

  // ── classification / preprocessing ───────────────────────────────────────

  /** True when the first token is a simulated shell command (no `oc` needed). */
  isShellLead(token) {
    return SHELL_COMMAND_SET.has(String(token ?? '').toLowerCase());
  }

  /** True when the whole command line should be treated as shell input. */
  isShellLine(command) {
    const text = String(command ?? '').trim();
    if (!text) return false;
    const first = tokenizeShell(text.split(/\s/)[0])[0] || '';
    return this.isShellLead(first);
  }

  _readFile(path) {
    return this.bar._readVirtualFile(String(path));
  }

  _fileExists(path) {
    return this._readFile(path) !== null;
  }

  _writeFile(path, content) {
    const written = this.bar._writeVirtualFile(String(path), String(content ?? ''));
    this._refreshFilesPanel();
    return written;
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

  _listFiles(path = '') {
    const files = this.bar._manifestFileList();
    const prefix = String(path || '').replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (!prefix || prefix === '.') return files;
    return files.filter((file) => file === prefix || file.startsWith(`${prefix}/`));
  }

  /**
   * Expand `$(command)` substitutions the way bash does before running a line.
   * @param {string} text
   * @returns {string}
   */
  expandSubstitutions(text) {
    let result = String(text ?? '');
    for (let guard = 0; guard < 10; guard += 1) {
      const match = result.match(/\$\(([^()\n]+)\)/);
      if (!match) break;
      const output = this._runSubcommand(match[1].trim());
      result = result.slice(0, match.index) + output + result.slice(match.index + match[0].length);
    }
    return result;
  }

  _runSubcommand(command) {
    const tokens = tokenizeShell(command);
    if (!tokens.length) return '';
    const result = this.runTokens(tokens, null);
    const text = result && typeof result.message === 'string' ? result.message : '';
    return text.trim().replace(/\n+/g, ' ');
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
        const command = header.replace(/<<-?\s*(['"]?)[A-Za-z_][A-Za-z0-9_]*\1/, ' ').replace(/\s{2,}/g, ' ').trim() || 'cat';
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
   * @returns {{error: boolean, message: string, clear?: boolean}}
   */
  runTokens(tokens, stdin) {
    const name = String(tokens[0] || '').toLowerCase();
    const args = tokens.slice(1);
    const handler = this[`_cmd_${name}`];
    if (!handler) {
      this.lastExitCode = 127;
      return { error: true, message: `bash: ${name}: command not found` };
    }
    try {
      const result = handler.call(this, args, stdin === null || stdin === undefined ? null : String(stdin)) || { error: false, message: '' };
      this.lastExitCode = result.error ? 1 : 0;
      return result;
    } catch (error) {
      this.lastExitCode = 1;
      return { error: true, message: `${name}: ${error && error.message ? error.message : error}` };
    }
  }

  // ── file helpers ─────────────────────────────────────────────────────────

  _readInputFiles(args, stdin, commandName) {
    const files = args.filter((arg) => !arg.startsWith('-'));
    if (!files.length) return { contents: stdin === null ? '' : stdin, label: null, files: [] };
    const parts = [];
    for (const file of files) {
      const content = this._readFile(file);
      if (content === null) return { error: `${commandName}: ${file}: No such file or directory` };
      parts.push({ file, content });
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
    const files = args.filter((arg) => !arg.startsWith('-') || arg === '-');
    if (!files.length) {
      if (stdin === null) return this._ok('');
      return this._ok(stdin);
    }
    const chunks = [];
    for (const file of files) {
      if (file === '-') {
        chunks.push(stdin === null ? '' : stdin);
        continue;
      }
      const content = this._readFile(file);
      if (content === null) {
        if (this._listFiles(file).length && file.endsWith('/')) return this._err(`cat: ${file}: Is a directory`);
        return this._err(`cat: ${file}: No such file or directory`);
      }
      chunks.push(content);
    }
    return this._ok(chunks.join(''));
  }

  _cmd_echo(args, stdin) {
    let newline = true;
    let interpret = false;
    const words = [];
    for (const arg of args) {
      if (/^-[neE]+$/.test(arg)) {
        if (arg.includes('n')) newline = false;
        if (arg.includes('e')) interpret = true;
        continue;
      }
      words.push(arg);
    }
    let text = words.join(' ');
    if (interpret) {
      text = text
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\\\/g, '\\');
    }
    if (stdin !== null && stdin !== '') text = words.length ? `${text}\n${stdin}` : stdin;
    return this._ok(newline ? `${text}\n` : text);
  }

  // ── grep / head / tail / wc ──────────────────────────────────────────────

  _cmd_grep(args, stdin) {
    const flags = {
      ignoreCase: false, invert: false, lineNumbers: false, count: false,
      filesWithMatches: false, onlyMatching: false,
      after: 0, before: 0,
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
            const setter = char === 'A' ? (value) => { flags.after = value; } : char === 'B' ? (value) => { flags.before = value; } : (value) => { flags.after = value; flags.before = value; };
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
          // -E/-F/-r/-q/--color etc. accepted; treated as plain-text matching
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
    if (pattern === null) return this._err('usage: grep [-ivnc] [-A num] [-B num] [-C num] pattern [file ...]');
    let matcher;
    try {
      matcher = new RegExp(pattern, flags.ignoreCase ? 'i' : '');
    } catch {
      matcher = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags.ignoreCase ? 'i' : '');
    }
    const hasContext = flags.after > 0 || flags.before > 0;
    const sources = files.length
      ? files.map((file) => ({ label: file, content: this._readFile(file) }))
      : [{ label: null, content: stdin === null ? '' : stdin }];
    const output = [];
    let matchedAny = false;
    for (const source of sources) {
      if (source.content === null) return this._err(`grep: ${source.label}: No such file or directory`);
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
        output.push(sources.length > 1 && source.label ? `${source.label}:${matchedIndexes.length}` : String(matchedIndexes.length));
        continue;
      }
      const multiFilePrefix = sources.length > 1 && source.label ? `${source.label}:` : '';
      if (!hasContext) {
        for (const index of matchedIndexes) {
          const line = lines[index];
          const prefix = `${multiFilePrefix}${flags.lineNumbers ? `${index + 1}:` : ''}`;
          if (flags.onlyMatching) {
            const matches = [...line.matchAll(new RegExp(matcher.source, flags.ignoreCase ? 'gi' : 'g'))].map((entry) => entry[0]);
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
    if ((flags.count || flags.filesWithMatches) && output.length) return this._ok(output.join('\n'));
    if (!matchedAny) this.lastExitCode = 1;
    return this._ok(output.join('\n'));
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
      const content = this._readFile(file);
      if (content === null) return this._err(`${name}: cannot open '${file}' for reading: No such file or directory`);
      if (positional.length > 1) out.push(`==> ${file} <==`);
      out.push(run(content));
      if (positional.length > 1) out.push('');
    }
    return this._ok(out.join('\n').replace(/\n+$/, ''));
  }

  _cmd_wc(args, stdin) {
    const flags = new Set(args.filter((arg) => /^-[lwc]+$/.test(arg)).flatMap((arg) => arg.slice(1).split('')));
    const files = args.filter((arg) => !arg.startsWith('-'));
    const countsFor = (content) => {
      const text = String(content ?? '');
      return {
        l: text === '' ? 0 : text.split('\n').filter((line, index, list) => !(index === list.length - 1 && line === '')).length,
        w: countWords(text),
        c: text.length,
      };
    };
    const format = (counts) => {
      if (flags.size) {
        return [...flags].sort().map((flag) => counts[flag]).join(' ');
      }
      return `${counts.l} ${counts.w} ${counts.c}`;
    };
    if (!files.length) return this._ok(format(countsFor(stdin === null ? '' : stdin)));
    const lines = [];
    let total = { l: 0, w: 0, c: 0 };
    for (const file of files) {
      const content = this._readFile(file);
      if (content === null) return this._err(`wc: ${file}: No such file or directory`);
      const counts = countsFor(content);
      total = { l: total.l + counts.l, w: total.w + counts.w, c: total.c + counts.c };
      lines.push(`${format(counts)} ${file}`);
    }
    if (files.length > 1) lines.push(`${format(total)} total`);
    return this._ok(lines.join('\n'));
  }

  // ── text utilities ───────────────────────────────────────────────────────

  _cmd_sort(args, stdin) {
    const numeric = args.includes('-n');
    const reverse = args.includes('-r');
    const unique = args.includes('-u');
    const files = args.filter((arg) => !arg.startsWith('-'));
    const input = files.length ? files.map((file) => this._readFile(file)).filter((text) => text !== null).join('\n') : stdin === null ? '' : stdin;
    let lines = String(input).split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.sort((left, right) => (numeric ? Number.parseFloat(left) - Number.parseFloat(right) : String(left).localeCompare(String(right))));
    if (reverse) lines.reverse();
    if (unique) lines = lines.filter((line, index) => index === 0 || line !== lines[index - 1]);
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
    return this._ok(out.map((entry) => (count ? `${String(entry.n).padStart(7)} ${entry.line}` : entry.line)).join('\n'));
  }

  _cmd_cut(args, stdin) {
    let delimiter = '\t';
    let fields = [];
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === '-d' || arg === '--delimiter') {
        delimiter = args[++i] ?? '\t';
        continue;
      }
      if (arg.startsWith('-d') && arg.length > 2) {
        delimiter = arg.slice(2);
        continue;
      }
      if (arg === '-f' || arg === '--fields') {
        fields = String(args[++i] ?? '1').split(',').map((value) => Number.parseInt(value, 10) - 1);
        continue;
      }
      if (arg.startsWith('-f') && arg.length > 2) {
        fields = arg.slice(2).split(',').map((value) => Number.parseInt(value, 10) - 1);
      }
    }
    if (!fields.length) fields = [0];
    const lines = String(stdin === null ? '' : stdin).split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const out = lines.map((line) => line.split(delimiter).filter((value, index) => fields.includes(index)).join(delimiter));
    return this._ok(out.join('\n'));
  }

  _cmd_tr(args, stdin) {
    if (args.length < 2) return this._err('tr: missing operand');
    const input = String(stdin === null ? '' : stdin);
    const [from, to] = args;
    const expand = (set) => {
      const chars = [];
      for (let i = 0; i < set.length; i += 1) {
        if (set[i + 1] === '-' && i + 2 < set.length) {
          for (let code = set.charCodeAt(i); code <= set.charCodeAt(i + 2); code += 1) chars.push(String.fromCharCode(code));
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
      out += index >= 0 ? toChars[index] ?? toChars[toChars.length - 1] ?? char : char;
    }
    return this._ok(out);
  }

  // ── editing / filesystem ─────────────────────────────────────────────────

  _cmd_vim(args, stdin) {
    return this._openEditor(args);
  }

  _cmd_vi(args, stdin) {
    return this._openEditor(args);
  }

  _openEditor(args) {
    const path = args.find((arg) => !arg.startsWith('-'));
    const panel = this.bar?.game?.manifestPanel || this.bar?.manifestPanel;
    if (!path) {
      if (panel && typeof panel.show === 'function') {
        panel.show();
        return this._ok('Opening the Files panel (manifest editor). Use `vim <file>` to edit a specific manifest.');
      }
      return this._err('vim: the manifest editor is not available in this build');
    }
    if (!this._fileExists(path)) this._writeFile(path, '');
    if (panel && typeof panel.openFile === 'function') {
      panel.openFile(path);
      return this._ok(`Opening ${path} in the Files panel (manifest editor).\nSave (Ctrl+S) to write the file, then apply it with \`oc apply -f ${path}\`.`);
    }
    return this._ok(`${path}\n(On a real cluster vim opens this file in the terminal; this simulator opens the Files panel when available.)`);
  }

  _cmd_ls(args, stdin) {
    const target = args.find((arg) => !arg.startsWith('-')) || '';
    const files = this._listFiles(target);
    if (!files.length) {
      if (target && this._fileExists(target)) return this._ok(target);
      return this._err(`ls: cannot access '${target || '.'}': No such file or directory`);
    }
    return this._ok(files.join('\n'));
  }

  _cmd_rm(args, stdin) {
    const force = args.some((arg) => /^-[a-zA-Z]*f/.test(arg));
    const files = args.filter((arg) => !arg.startsWith('-'));
    if (!files.length) return this._err('rm: missing operand');
    const errors = [];
    for (const file of files) {
      if (!this._fileExists(file)) {
        if (!force) errors.push(`rm: cannot remove '${file}': No such file or directory`);
        continue;
      }
      if (typeof this.bar.manifestEngine?.deleteFile === 'function') this.bar.manifestEngine.deleteFile(file);
      this._refreshFilesPanel();
    }
    if (errors.length) return this._err(errors.join('\n'));
    return this._ok('');
  }

  _cmd_touch(args, stdin) {
    const files = args.filter((arg) => !arg.startsWith('-'));
    if (!files.length) return this._err('touch: missing file operand');
    for (const file of files) {
      if (!this._fileExists(file)) this._writeFile(file, '');
    }
    return this._ok('');
  }

  _cmd_cp(args, stdin) {
    const files = args.filter((arg) => !arg.startsWith('-'));
    if (files.length !== 2) return this._err('cp: missing destination file operand after source');
    const [source, destination] = files;
    const content = this._readFile(source);
    if (content === null) return this._err(`cp: cannot stat '${source}': No such file or directory`);
    this._writeFile(destination, content);
    return this._ok('');
  }

  _cmd_mv(args, stdin) {
    const files = args.filter((arg) => !arg.startsWith('-'));
    if (files.length !== 2) return this._err('mv: missing destination file operand after source');
    const [source, destination] = files;
    const content = this._readFile(source);
    if (content === null) return this._err(`mv: cannot stat '${source}': No such file or directory`);
    this._writeFile(destination, content);
    if (typeof this.bar.manifestEngine?.deleteFile === 'function') this.bar.manifestEngine.deleteFile(source);
    this._refreshFilesPanel();
    return this._ok('');
  }

  _cmd_pwd() {
    return this._ok(this.cwd || '/');
  }

  _cmd_which(args) {
    if (!args.length) return this._err('which: missing argument');
    return this._ok(
      args
        .map((name) => {
          if (this.isShellLead(name) || name === 'oc') return `/usr/bin/${name}`;
          return `which: no ${name} in (/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin)`;
        })
        .join('\n'),
    );
  }

  _cmd_env() {
    return this._ok(
      [
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'HOME=/home/student',
        `USER=${this.bar?.currentUser || 'kubeadmin'}`,
        'KUBECONFIG=/home/student/.kube/config',
        'SHELL=/bin/bash',
      ].join('\n'),
    );
  }

  _cmd_printenv() {
    return this._cmd_env();
  }

  // ── crypto / registry tools ──────────────────────────────────────────────

  _cmd_openssl(args, stdin) {
    const sub = String(args[0] || '').toLowerCase();
    if (sub !== 'rand') {
      return this._err(`openssl: unsupported subcommand "${sub || ''}" (simulator supports: openssl rand -hex|-base64 <n>)`);
    }
    let mode = 'hex';
    let length = 16;
    for (let i = 1; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === '-hex' || arg === '-base64') mode = arg.slice(1);
      else if (/^\d+$/.test(arg)) length = Number(arg);
    }
    let output = '';
    let counter = 0;
    while (output.length < length * (mode === 'hex' ? 2 : 2)) {
      const seed = `${Date.now()}-${counter++}-${Math.random()}`;
      let hash = 0x811c9dc5;
      for (let i = 0; i < seed.length; i += 1) hash = Math.imul(hash ^ seed.charCodeAt(i), 0x01000193) >>> 0;
      output += hash.toString(16).padStart(8, '0');
    }
    if (mode === 'hex') return this._ok(output.slice(0, length * 2));
    const bytes = [];
    for (let i = 0; i < output.length; i += 2) bytes.push(Number.parseInt(output.slice(i, i + 2), 16));
    const base =
      typeof Buffer !== 'undefined'
        ? Buffer.from(bytes).toString('base64')
        : (() => {
            let text = '';
            for (const byte of bytes) text += String.fromCharCode(byte);
            return typeof btoa === 'function' ? btoa(text) : output.slice(0, length);
          })();
    return this._ok(base);
  }

  _cmd_skopeo(args, stdin) {
    const sub = String(args[0] || '').toLowerCase();
    if (sub !== 'inspect') {
      return this._err(`FATA[0000] skopeo: unsupported command "${sub || ''}" (simulator supports: skopeo inspect [--format=...] docker://<image>)`);
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
    const bare = String(reference).replace(/^docker:\/\//, '').replace(/^oci:\/\//, '');
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
    if (result && typeof result === 'object') return { error: Boolean(result.error), message: String(result.message ?? '') };
    return this._ok(String(result ?? ''));
  }

  // ── terminal control ─────────────────────────────────────────────────────

  _cmd_clear() {
    return { error: false, message: '', clear: true };
  }

  _cmd_exit() {
    return { error: false, message: '', exit: true };
  }
}

export default ShellTools;
