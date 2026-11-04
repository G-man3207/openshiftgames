/**
 * YamlParser — dependency-free YAML parser/stringifier for OpenShift Games.
 *
 * Implements the practical YAML subset used by OpenShift/Kubernetes manifests:
 *   - block mappings and sequences (any indentation, sequence-of-mappings)
 *   - flow collections: `{a: 1}` and `[1, 2]` (may span multiple lines)
 *   - plain, single-quoted and double-quoted scalars
 *   - booleans (`true`/`false` and capitalised forms), integers, floats,
 *     `.inf`/`.nan`, `null`/`~`, everything else is a string
 *   - comments (`#`) outside quoted scalars
 *   - multiple documents separated by `---` (and terminated by `...`)
 *   - literal (`|`) and folded (`>`) block scalars with chomping (`-`, `+`)
 *     and optional explicit indentation digits
 *
 * Deliberately NOT supported (documented in docs/declarative-engine.md):
 * anchors/aliases (`&a`/`*a`), merge keys (`<<`), complex keys (`? `),
 * custom tags, and multi-line plain (unquoted, unfolded) scalars.
 *
 * Errors are thrown as `YamlParseError` with `{line, message, file}` so callers
 * (ManifestEngine, the Files panel, the verifier) can render structured errors.
 *
 * Public API:
 *   parseYaml(text, {file?}) -> Array<object>      (empty documents skipped)
 *   parseDocument(text, {file?}) -> object|null
 *   stringifyYaml(value) -> string
 *   selfTest() -> {ok:boolean, failures:Array<{name,error}>}
 *   YamlParseError, parseYamlSafe(text, opts)
 */

export class YamlParseError extends Error {
  /**
   * @param {string} message
   * @param {number} [line] 1-based source line
   * @param {string} [file]
   */
  constructor(message, line = 1, file = undefined) {
    super(message);
    this.name = 'YamlParseError';
    this.line = Number.isFinite(line) ? line : 1;
    if (file) this.file = file;
  }

  toJSON() {
    const out = { line: this.line, message: this.message };
    if (this.file) out.file = this.file;
    return out;
  }
}

/** @param {string} text @param {{file?: string}} [opts] @returns {object[]} */
export function parseYaml(text, opts = {}) {
  const file = opts.file;
  const source = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  const rawLines = source.split('\n');
  /** @type {Array<Array<object>>} */
  const docSegments = [];
  let current = [];

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const trimmed = raw.trim();
    const { indent, tabbed } = _indentInfo(raw, i + 1, file);
    if (!trimmed) {
      current.push({ text: raw, lineNo: i + 1, indent, tabbed, content: '' });
      continue;
    }
    if (
      indent === 0 &&
      (trimmed === '---' || trimmed.startsWith('--- ') || trimmed.startsWith('---#'))
    ) {
      // `---` starts a new document. Anything after the marker is a directive
      // or a complete document value; both are outside the practical subset.
      let rest = trimmed.slice(3).trim();
      if (rest.startsWith('#')) rest = '';
      if (rest) {
        throw new YamlParseError(
          'content after "---" document marker is not supported',
          i + 1,
          file
        );
      }
      docSegments.push(current);
      current = [];
      continue;
    }
    if (indent === 0 && (trimmed === '...' || trimmed.startsWith('... '))) {
      docSegments.push(current);
      current = [];
      continue;
    }
    if (indent === 0 && trimmed.startsWith('%')) {
      // %YAML / %TAG directives: ignore, they do not change this subset.
      continue;
    }
    current.push({ text: raw, lineNo: i + 1, indent, tabbed, content: trimmed });
  }
  docSegments.push(current);

  const docs = [];
  for (const segment of docSegments) {
    const tokens = segment.map((t) => ({
      ...t,
      empty: t.text.trim() === '' || t.text.trim().startsWith('#'),
    }));
    const first = _skipEmpty(tokens, 0);
    if (first >= tokens.length) continue; // empty document (e.g. trailing ---)

    const result = _parseNode(tokens, first, tokens[first].indent, file);
    const after = _skipEmpty(tokens, result.index);
    if (after < tokens.length) {
      throw new YamlParseError(
        `unexpected content after document value: "${tokens[after].text.trim()}"`,
        tokens[after].lineNo,
        file
      );
    }
    docs.push(result.value);
  }
  return docs;
}

/** Parse a single-document YAML string. Returns null for an empty document. */
export function parseDocument(text, opts = {}) {
  const docs = parseYaml(text, opts);
  return docs.length > 0 ? docs[0] : null;
}

/** Non-throwing helper: `{ok, docs, errors}`. */
export function parseYamlSafe(text, opts = {}) {
  try {
    return { ok: true, docs: parseYaml(text, opts), errors: [] };
  } catch (err) {
    return { ok: false, docs: [], errors: [toYamlError(err)] };
  }
}

/** Normalise any thrown parser error to `{file?, line, message}`. */
export function toYamlError(err) {
  if (err && err.name === 'YamlParseError') return err.toJSON();
  return { line: 1, message: err?.message || String(err) };
}

// ─── tokenizing helpers ─────────────────────────────────────────────────────

/**
 * Leading indentation of a line. Tabs may only appear as *content* after the
 * indentation (valid inside block scalars); a tab at column 0 is rejected here,
 * and structural parsers reject `tabbed` lines with a clear error.
 * @returns {{indent: number, tabbed: boolean}}
 */
function _indentInfo(text, lineNo, file) {
  let i = 0;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
    if (text[i] === '\t') {
      if (i === 0) {
        throw new YamlParseError('tab characters must not be used for indentation', lineNo, file);
      }
      return { indent: i, tabbed: true };
    }
    i++;
  }
  return { indent: i, tabbed: false };
}

function _skipEmpty(tokens, start) {
  let i = start;
  while (i < tokens.length && tokens[i].empty) i++;
  return i;
}

/** A tab after leading spaces is only legal as block-scalar content. */
function _rejectTabbedIndent(token, file) {
  if (token && token.tabbed) {
    throw new YamlParseError('tab characters must not be used for indentation', token.lineNo, file);
  }
}

function _parseNode(tokens, index, indent, file) {
  const line = tokens[index];
  _rejectTabbedIndent(line, file);
  if (_isSeqIndicator(line.content)) return _parseSequence(tokens, index, indent, file);
  if (line.content.startsWith('[') || line.content.startsWith('{')) {
    const flow = _collectFlow(tokens, index, line.content, line.lineNo, file);
    return { value: _parseFlowValue(flow.text, line.lineNo, file), index: flow.index };
  }
  if (_findMappingColon(line.content) !== -1) return _parseMapping(tokens, index, indent, file);
  // Root scalar document (e.g. `42` or `hello`).
  if (index + 1 < tokens.length && _skipEmpty(tokens, index + 1) < tokens.length) {
    throw new YamlParseError('unexpected content after scalar document value', line.lineNo, file);
  }
  return { value: _parseInlineValue(line.content, line.lineNo, file), index: index + 1 };
}

function _isSeqIndicator(content) {
  return content === '-' || content.startsWith('- ') || content.startsWith('-\t');
}

function _parseSequence(tokens, index, indent, file) {
  const items = [];
  let i = index;
  while (true) {
    i = _skipEmpty(tokens, i);
    if (i >= tokens.length) break;
    const line = tokens[i];
    if (line.indent < indent) break;
    _rejectTabbedIndent(line, file);
    if (line.indent > indent) {
      throw new YamlParseError('bad indentation of a sequence entry', line.lineNo, file);
    }
    if (!_isSeqIndicator(line.content)) break;

    const dash = line.text.indexOf('-', indent);
    let contentStart = dash + 1;
    while (
      contentStart < line.text.length &&
      (line.text[contentStart] === ' ' || line.text[contentStart] === '\t')
    ) {
      contentStart++;
    }
    const inline = line.text.slice(contentStart).replace(/\s+$/, '');

    if (!inline) {
      const next = _skipEmpty(tokens, i + 1);
      if (next < tokens.length && tokens[next].indent > indent) {
        const nested = _parseNode(tokens, next, tokens[next].indent, file);
        items.push(nested.value);
        i = nested.index;
      } else {
        // A bare `-` is an empty (null) item; a following dash at the same
        // indent is a sibling, not a nested sequence.
        items.push(null);
        i++;
      }
      continue;
    }

    if (_isBlockScalarHeader(inline)) {
      const block = _parseBlockScalar(tokens, i + 1, indent, inline, line.lineNo, file);
      items.push(block.value);
      i = block.index;
      continue;
    }

    // Rewrite this token so the inline value can be parsed as a normal node.
    tokens[i] = {
      ...line,
      text: `${' '.repeat(contentStart)}${inline}`,
      indent: contentStart,
      content: inline,
    };

    if (inline.startsWith('[') || inline.startsWith('{')) {
      const flow = _collectFlow(tokens, i, inline, line.lineNo, file);
      items.push(_parseFlowValue(flow.text, line.lineNo, file));
      i = flow.index;
    } else if (_isSeqIndicator(inline) || _findMappingColon(inline) !== -1) {
      const nested = _parseNode(tokens, i, contentStart, file);
      items.push(nested.value);
      i = nested.index;
    } else {
      items.push(_parseInlineValue(inline, line.lineNo, file));
      i++;
    }
  }
  return { value: items, index: i };
}

function _parseMapping(tokens, index, indent, file) {
  const obj = {};
  let i = index;
  while (true) {
    i = _skipEmpty(tokens, i);
    if (i >= tokens.length) break;
    const line = tokens[i];
    if (line.indent < indent) break;
    _rejectTabbedIndent(line, file);
    if (line.indent > indent) {
      throw new YamlParseError('bad indentation of a mapping entry', line.lineNo, file);
    }
    if (_isSeqIndicator(line.content)) break;

    const colon = _findMappingColon(line.content);
    if (colon === -1) {
      throw new YamlParseError(
        `could not find expected ':' in "${line.content}"`,
        line.lineNo,
        file
      );
    }
    const key = _parseKey(line.content.slice(0, colon), line.lineNo, file);
    const restRaw = line.content.slice(colon + 1);
    const rest = restRaw.trim();
    let value;

    if (rest === '' || rest.startsWith('#')) {
      const next = _skipEmpty(tokens, i + 1);
      if (next < tokens.length && tokens[next].indent > indent) {
        const nested = _parseNode(tokens, next, tokens[next].indent, file);
        value = nested.value;
        i = nested.index;
      } else if (
        next < tokens.length &&
        tokens[next].indent === indent &&
        _isSeqIndicator(tokens[next].content)
      ) {
        const nested = _parseSequence(tokens, next, indent, file);
        value = nested.value;
        i = nested.index;
      } else {
        value = null;
        i++;
      }
    } else if (_isBlockScalarHeader(rest)) {
      const block = _parseBlockScalar(tokens, i + 1, indent, rest, line.lineNo, file);
      value = block.value;
      i = block.index;
    } else if (rest.startsWith('[') || rest.startsWith('{')) {
      const flow = _collectFlow(tokens, i, rest, line.lineNo, file);
      value = _parseFlowValue(flow.text, line.lineNo, file);
      i = flow.index;
    } else {
      value = _parseInlineValue(rest, line.lineNo, file);
      i++;
    }
    obj[key] = value;
  }
  return { value: obj, index: i };
}

function _findMappingColon(content) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (quote) {
      if (quote === '"' && ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) {
        if (quote === "'" && content[i + 1] === "'") {
          i++;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[' || ch === '{') {
      depth++;
      continue;
    }
    if (ch === ']' || ch === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(content[i - 1]))) return -1;
    if (ch === ':' && depth === 0 && (i + 1 === content.length || /\s/.test(content[i + 1])))
      return i;
  }
  return -1;
}

function _parseKey(raw, lineNo, file) {
  const key = raw.trim();
  if (!key) throw new YamlParseError('empty mapping key', lineNo, file);
  if (key.startsWith('?')) {
    throw new YamlParseError('complex mapping keys ("? ") are not supported', lineNo, file);
  }
  if (key.startsWith('&') || key.startsWith('*')) {
    throw new YamlParseError('YAML anchors/aliases are not supported', lineNo, file);
  }
  if (key.startsWith('"') || key.startsWith("'")) {
    const quoted = _parseQuoted(key, lineNo, file);
    if (quoted.index !== key.length) {
      throw new YamlParseError('unexpected content after quoted mapping key', lineNo, file);
    }
    return quoted.value;
  }
  return key;
}

// ─── scalars ────────────────────────────────────────────────────────────────

function _parseInlineValue(text, lineNo, file) {
  let s = _stripInlineComment(text).trim();
  if (s === '') return null;
  if (s.startsWith('&') || s.startsWith('*')) {
    throw new YamlParseError('YAML anchors/aliases are not supported', lineNo, file);
  }
  if (s.startsWith('!')) {
    // Local tags (`!!str`, `!Ref`) carry no useful meaning here; strip the tag.
    s = s.replace(/^!\S*\s*/, '');
    if (s === '') return null;
  }
  if (s.startsWith('"') || s.startsWith("'")) {
    const quoted = _parseQuoted(s, lineNo, file);
    if (s.slice(quoted.index).trim() !== '') {
      throw new YamlParseError('unexpected content after quoted scalar', lineNo, file);
    }
    return quoted.value;
  }
  if (s.startsWith('[') || s.startsWith('{')) return _parseFlowValue(s, lineNo, file);
  return _inferScalar(s);
}

function _stripInlineComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (quote === '"' && ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) {
        if (quote === "'" && text[i + 1] === "'") {
          i++;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).replace(/\s+$/, '');
    }
  }
  return text;
}

function _parseQuoted(text, lineNo, file) {
  const quote = text[0];
  let out = '';
  let i = 1;
  while (i < text.length) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        return { value: out, index: i + 1 };
      }
      out += ch;
      i++;
      continue;
    }
    if (ch === '"') return { value: out, index: i + 1 };
    if (ch === '\\') {
      const next = text[i + 1];
      switch (next) {
        case 'n':
          out += '\n';
          break;
        case 't':
          out += '\t';
          break;
        case 'r':
          out += '\r';
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case '0':
          out += '\0';
          break;
        case '"':
          out += '"';
          break;
        case '\\':
          out += '\\';
          break;
        case '/':
          out += '/';
          break;
        case ' ':
          out += ' ';
          break;
        case 'u': {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new YamlParseError('invalid \\u escape in double-quoted scalar', lineNo, file);
          }
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        case 'x': {
          const hex = text.slice(i + 2, i + 4);
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
            throw new YamlParseError('invalid \\x escape in double-quoted scalar', lineNo, file);
          }
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          continue;
        }
        default:
          out += next ?? '';
          i += 2;
          continue;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  throw new YamlParseError('unterminated quoted scalar', lineNo, file);
}

function _inferScalar(s) {
  const str = s.trim();
  if (str === '' || str === '~' || str === 'null' || str === 'Null' || str === 'NULL') return null;
  if (str === 'true' || str === 'True' || str === 'TRUE') return true;
  if (str === 'false' || str === 'False' || str === 'FALSE') return false;
  if (/^[-+]?[0-9]+$/.test(str)) {
    const n = Number(str);
    if (Number.isSafeInteger(n)) return n;
    return str;
  }
  if (/^0x[0-9a-fA-F]+$/.test(str)) return parseInt(str, 16);
  if (
    /^[-+]?(?:[0-9]+\.[0-9]*|\.[0-9]+|[0-9]+)(?:[eE][-+]?[0-9]+)?$/.test(str) &&
    /[.eE]/.test(str)
  ) {
    const n = Number(str);
    if (Number.isFinite(n)) return n;
  }
  if (str === '.inf' || str === '+.inf' || str === 'Infinity') return Infinity;
  if (str === '-.inf' || str === '-Infinity') return -Infinity;
  if (str === '.nan' || str === '.NaN') return NaN;
  return str;
}

// ─── flow collections ───────────────────────────────────────────────────────

function _collectFlow(tokens, index, first, lineNo, file) {
  let text = first;
  let i = index + 1;
  while (!_flowBalanced(text)) {
    if (i >= tokens.length) {
      throw new YamlParseError('unterminated flow collection', lineNo, file);
    }
    // Keep a newline between lines: flow comments end at a line break and
    // multi-line plain scalars in flow context fold the break to a space.
    if (!tokens[i].empty) text += `\n${tokens[i].content}`;
    i++;
  }
  return { text, index: i };
}

function _flowBalanced(text) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (quote === '"' && ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) {
        if (quote === "'" && text[i + 1] === "'") {
          i++;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
  }
  return depth <= 0;
}

function _parseFlowValue(text, lineNo, file) {
  const parser = new _FlowParser(text, lineNo, file);
  const value = parser.parseNode();
  parser.skipSpace();
  if (!parser.done()) {
    throw new YamlParseError(
      `unexpected content in flow collection: "${parser.rest()}"`,
      lineNo,
      file
    );
  }
  return value;
}

class _FlowParser {
  constructor(text, lineNo, file) {
    this.text = text;
    this.i = 0;
    this.lineNo = lineNo;
    this.file = file;
  }

  done() {
    return this.i >= this.text.length;
  }

  rest() {
    return this.text.slice(this.i).trim();
  }

  skipSpace() {
    while (this.i < this.text.length) {
      const ch = this.text[this.i];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        this.i++;
        continue;
      }
      if (ch === '#') {
        while (this.i < this.text.length && this.text[this.i] !== '\n') this.i++;
        continue;
      }
      break;
    }
  }

  fail(message) {
    throw new YamlParseError(message, this.lineNo, this.file);
  }

  parseNode() {
    this.skipSpace();
    if (this.done()) this.fail('unexpected end of flow collection');
    const ch = this.text[this.i];
    if (ch === '[') return this.parseSequence();
    if (ch === '{') return this.parseMapping();
    if (ch === '"' || ch === "'") {
      const quoted = _parseQuoted(this.text.slice(this.i), this.lineNo, this.file);
      this.i += quoted.index;
      return quoted.value;
    }
    return this.parsePlain([',', ']', '}']);
  }

  parseSequence() {
    this.i++; // [
    const out = [];
    this.skipSpace();
    if (this.text[this.i] === ']') {
      this.i++;
      return out;
    }
    while (true) {
      out.push(this.parseNode());
      this.skipSpace();
      const ch = this.text[this.i];
      if (ch === ',') {
        this.i++;
        this.skipSpace();
        if (this.text[this.i] === ']') {
          this.i++;
          break;
        }
        continue;
      }
      if (ch === ']') {
        this.i++;
        break;
      }
      this.fail('expected "," or "]" in flow sequence');
    }
    return out;
  }

  parseMapping() {
    this.i++; // {
    const out = {};
    this.skipSpace();
    if (this.text[this.i] === '}') {
      this.i++;
      return out;
    }
    while (true) {
      this.skipSpace();
      let key;
      if (this.text[this.i] === '"' || this.text[this.i] === "'") {
        const quoted = _parseQuoted(this.text.slice(this.i), this.lineNo, this.file);
        this.i += quoted.index;
        key = quoted.value;
      } else {
        key = this.parsePlain([':', ',', '}']);
      }
      this.skipSpace();
      let value = null;
      if (this.text[this.i] === ':') {
        this.i++;
        value = this.parseNode();
      }
      out[String(key)] = value;
      this.skipSpace();
      const ch = this.text[this.i];
      if (ch === ',') {
        this.i++;
        this.skipSpace();
        if (this.text[this.i] === '}') {
          this.i++;
          break;
        }
        continue;
      }
      if (ch === '}') {
        this.i++;
        break;
      }
      this.fail('expected "," or "}" in flow mapping');
    }
    return out;
  }

  parsePlain(stops) {
    const start = this.i;
    while (this.i < this.text.length) {
      const ch = this.text[this.i];
      if (stops.includes(ch)) break;
      if (ch === '#' && (this.i === start || /\s/.test(this.text[this.i - 1]))) break;
      this.i++;
    }
    // YAML folds line breaks in flow plain scalars into a single space.
    const raw = this.text
      .slice(start, this.i)
      .replace(/\s*\n\s*/g, ' ')
      .trim();
    return _inferScalar(raw);
  }
}

// ─── block scalars ──────────────────────────────────────────────────────────

function _isBlockScalarHeader(text) {
  return /^[|>](?:[+-]?[1-9]?[+-]?)(?:\s+#.*)?$/.test(text.trim());
}

function _parseBlockScalar(tokens, startIndex, parentIndent, header, lineNo, file) {
  const cleaned = header.trim().replace(/\s+#.*$/, '');
  const style = cleaned[0];
  const indicators = cleaned.slice(1);
  const explicit = /[1-9]/.exec(indicators);
  const chomp = indicators.includes('-') ? '-' : indicators.includes('+') ? '+' : '';
  const explicitIndent = explicit ? parseInt(explicit[0], 10) : 0;

  let contentIndent = explicit ? parentIndent + explicitIndent : 0;
  const contentLines = [];
  let i = startIndex;
  let seenNonBlank = false;

  while (i < tokens.length) {
    const line = tokens[i];
    const isBlank = line.text.trim() === '';
    if (isBlank) {
      contentLines.push('');
      i++;
      continue;
    }
    if (line.indent <= parentIndent) break;
    if (!seenNonBlank) {
      seenNonBlank = true;
      if (!contentIndent) contentIndent = line.indent;
      if (line.indent < contentIndent) {
        throw new YamlParseError('bad indentation in block scalar', line.lineNo, file);
      }
    }
    if (line.indent < contentIndent) {
      throw new YamlParseError('bad indentation in block scalar', line.lineNo, file);
    }
    contentLines.push(line.text.slice(contentIndent));
    i++;
  }

  let body;
  if (style === '|') body = contentLines.join('\n');
  else body = _foldBlockLines(contentLines);

  if (chomp === '-') body = body.replace(/\n+$/, '');
  else if (chomp === '+')
    body = body; // keep every trailing line break
  else body = body === '' ? '' : body.replace(/\n+$/, '') + '\n';

  return { value: body, index: i };
}

function _foldBlockLines(lines) {
  // Folded style: a single line break between two normal lines becomes a
  // space, blank lines are preserved as line breaks, and lines that are more
  // indented than the block keep their breaks and indentation literally.
  let out = '';
  let prev = null; // last non-blank line: {text, more}
  let blanks = 0;
  for (const line of lines) {
    if (line === '') {
      blanks++;
      continue;
    }
    const more = /^[ \t]/.test(line);
    if (prev) {
      if (prev.more || more) out += '\n'.repeat(blanks + 1);
      else if (blanks === 0) out += ' ';
      else out += '\n'.repeat(blanks);
    }
    out += line;
    prev = { text: line, more };
    blanks = 0;
  }
  // Trailing blank lines (mattering for `>+` chomping) are line breaks.
  if (blanks > 0) out += '\n'.repeat(blanks);
  return out;
}
// ─── stringifier ────────────────────────────────────────────────────────────

const RESERVED_WORDS = new Set([
  'true',
  'false',
  'null',
  '~',
  'True',
  'False',
  'Null',
  'TRUE',
  'FALSE',
  'NULL',
  'yes',
  'no',
  'on',
  'off',
  'Yes',
  'No',
  'On',
  'Off',
]);

function _needsQuotes(str) {
  if (str === '') return true;
  if (RESERVED_WORDS.has(str)) return true;
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(str)) return true;
  if (/^0x[0-9a-fA-F]+$/.test(str)) return true;
  if (/^[\s]|[\s]$/.test(str)) return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(str)) return true;
  if (str.startsWith('---') || str.startsWith('...')) return true;
  if (str.includes(': ') || str.includes(' #') || str.endsWith(':')) return true;
  if (/[\n\r\t]/.test(str)) return true;
  if (/[\u0000-\u001f]/.test(str)) return true;
  return false;
}

function _quoteKey(key) {
  const str = String(key);
  if (str === '' || _needsQuotes(str) || /[:[\]{},#&*!|>'"%@`]/.test(str) || /^\s|\s$/.test(str)) {
    return JSON.stringify(str);
  }
  return str;
}

function _formatString(str) {
  if (_needsQuotes(str)) return JSON.stringify(str);
  return str;
}

function _formatScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return '.nan';
    if (value === Infinity) return '.inf';
    if (value === -Infinity) return '-.inf';
    return String(value);
  }
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === 'string') return _formatString(value);
  return _formatString(String(value));
}

function _indent(n) {
  return '  '.repeat(n);
}

function _renderBlockString(str, indent) {
  // Tabs are not representable as block-scalar indentation in this parser.
  if (/\t/.test(str)) return JSON.stringify(str);
  // Choose a chomping indicator that round-trips the exact string.
  let style = '|';
  let body = str;
  if (str.endsWith('\n')) {
    if (str.endsWith('\n\n')) {
      style = '|+';
      body = str.slice(0, -1);
    } else {
      style = '|';
      body = str.slice(0, -1);
    }
  } else {
    style = '|-';
  }
  // Leading whitespace would be eaten by the block-scalar indentation rules;
  // use an explicit indentation indicator (the renderer always indents by one
  // level = two spaces).
  const rawLines = body.split('\n');
  const needsExplicit = rawLines.some((line) => /^[ \t]/.test(line));
  const indicator = needsExplicit ? `${style[0]}2${style.slice(1)}` : style;
  const pad = _indent(indent + 1);
  const lines = rawLines.map((line) => (line === '' ? '' : pad + line));
  return `${indicator}\n${lines.join('\n')}`;
}

function _renderMap(obj, indent) {
  const pad = _indent(indent);
  const lines = [];
  for (const [key, value] of Object.entries(obj)) {
    const label = `${pad}${_quoteKey(key)}:`;
    if (value === null || value === undefined) {
      lines.push(`${label} null`);
    } else if (typeof value === 'string' && value.includes('\n')) {
      lines.push(`${label} ${_renderBlockString(value, indent)}`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) lines.push(`${label} []`);
      else lines.push(`${label}\n${_renderSeq(value, indent + 1)}`);
    } else if (_isPlainObject(value)) {
      if (Object.keys(value).length === 0) lines.push(`${label} {}`);
      else lines.push(`${label}\n${_renderMap(value, indent + 1)}`);
    } else {
      lines.push(`${label} ${_formatScalar(value)}`);
    }
  }
  return lines.join('\n');
}

function _renderSeq(arr, indent) {
  const pad = _indent(indent);
  const lines = [];
  for (const item of arr) {
    if (item === null || item === undefined) {
      lines.push(`${pad}- null`);
      continue;
    }
    if (typeof item === 'string' && item.includes('\n')) {
      lines.push(`${pad}- ${_renderBlockString(item, indent)}`);
      continue;
    }
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      lines.push(`${pad}- ${_formatScalar(item)}`);
      continue;
    }
    if (Array.isArray(item)) {
      if (item.length === 0) {
        lines.push(`${pad}- []`);
        continue;
      }
      const inner = _renderSeq(item, indent + 1).split('\n');
      lines.push(`${pad}- ${inner[0].trimStart()}`);
      for (let k = 1; k < inner.length; k++) lines.push(inner[k]);
      continue;
    }
    if (_isPlainObject(item)) {
      if (Object.keys(item).length === 0) {
        lines.push(`${pad}- {}`);
        continue;
      }
      const inner = _renderMap(item, indent + 1).split('\n');
      lines.push(`${pad}- ${inner[0].trimStart()}`);
      for (let k = 1; k < inner.length; k++) lines.push(inner[k]);
      continue;
    }
    lines.push(`${pad}- ${_formatScalar(item)}`);
  }
  return lines.join('\n');
}

function _isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Serialise a JS value (object/array/scalar) as a single YAML document.
 * Object key order is preserved; strings that need quoting are JSON-quoted so
 * the parser round-trips them exactly.
 */
export function stringifyYaml(value) {
  if (value === null || value === undefined) return 'null\n';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]\n';
    return `${_renderSeq(value, 0)}\n`;
  }
  if (_isPlainObject(value)) {
    if (Object.keys(value).length === 0) return '{}\n';
    return `${_renderMap(value, 0)}\n`;
  }
  return `${_formatScalar(value)}\n`;
}

// ─── self test ──────────────────────────────────────────────────────────────

function _deepEqual(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Built-in parser/stringifier conformance suite (no dependencies, no DOM).
 * @returns {{ok: boolean, failures: Array<{name: string, error: string}>}}
 */
export function selfTest() {
  /** @type {Array<{name: string, error: string}>} */
  const failures = [];
  const check = (name, fn) => {
    try {
      if (fn() === false) failures.push({ name, error: 'assertion returned false' });
    } catch (err) {
      failures.push({ name, error: err?.message || String(err) });
    }
  };
  const expectEqual = (actual, expected, label) => {
    if (!_deepEqual(actual, expected)) {
      throw new Error(
        `${label || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
      );
    }
  };

  check('mapping scalars and types', () => {
    const doc = parseDocument(`
name: web
replicas: 2
ratio: 0.5
enabled: true
disabled: false
empty: null
tilde: ~
quoted: "true"
single: 'it''s ok'
`);
    expectEqual(doc, {
      name: 'web',
      replicas: 2,
      ratio: 0.5,
      enabled: true,
      disabled: false,
      empty: null,
      tilde: null,
      quoted: 'true',
      single: "it's ok",
    });
  });

  check('comments are ignored', () => {
    const doc = parseDocument(`
# leading comment
image: nginx:1.25 # trailing comment
url: http://example.com/#fragment
`);
    expectEqual(doc, { image: 'nginx:1.25', url: 'http://example.com/#fragment' });
  });

  check('nested mapping and sequence of mappings', () => {
    const doc = parseDocument(`
spec:
  containers:
    - name: main
      image: nginx:latest
      ports:
        - containerPort: 8080
    - name: sidecar
      image: busybox
`);
    expectEqual(doc, {
      spec: {
        containers: [
          { name: 'main', image: 'nginx:latest', ports: [{ containerPort: 8080 }] },
          { name: 'sidecar', image: 'busybox' },
        ],
      },
    });
  });

  check('sequence of scalars and indentless sequence', () => {
    const doc = parseDocument(`
commands:
- get
- list
- watch
`);
    expectEqual(doc, { commands: ['get', 'list', 'watch'] });
  });

  check('multi-document split', () => {
    const docs = parseYaml(`
apiVersion: v1
kind: Service
metadata:
  name: web
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
`);
    expectEqual(docs.length, 2);
    expectEqual(docs[0].kind, 'Service');
    expectEqual(docs[1].kind, 'Deployment');
  });

  check('empty and comment-only documents are skipped', () => {
    expectEqual(parseYaml(''), []);
    expectEqual(parseYaml('# only a comment\n'), []);
    expectEqual(parseYaml('---\n---\n'), []);
  });

  check('literal block scalar with clip', () => {
    const doc = parseDocument('script: |\n  line one\n  line two\n');
    expectEqual(doc, { script: 'line one\nline two\n' });
  });

  check('literal block scalar with strip', () => {
    const doc = parseDocument('script: |-\n  line one\n  line two\n');
    expectEqual(doc, { script: 'line one\nline two' });
  });

  check('literal block scalar preserves blank lines', () => {
    const doc = parseDocument('script: |\n  one\n\n  two\n');
    expectEqual(doc, { script: 'one\n\ntwo\n' });
  });

  check('block scalar chomping keep and strip', () => {
    expectEqual(parseDocument('a: |+\n  x\n\n'), { a: 'x\n\n' });
    expectEqual(parseDocument('a: |+\n  x\n'), { a: 'x\n' });
    expectEqual(parseDocument('a: |-\n  x\n\n'), { a: 'x' });
    expectEqual(parseDocument('a: |\n  x\n\n'), { a: 'x\n' });
    expectEqual(parseDocument('a: >-\n  x\n  y\n'), { a: 'x y' });
  });

  check('document markers with trailing comments', () => {
    const docs = parseYaml('--- # first\na: 1\n--- # second\nb: 2\n');
    expectEqual(docs, [{ a: 1 }, { b: 2 }]);
  });

  check('folded block scalar', () => {
    const doc = parseDocument('message: >\n  hello\n  world\n');
    expectEqual(doc, { message: 'hello world\n' });
  });

  check('flow collections', () => {
    const doc = parseDocument(`
map: {a: 1, b: "two", c: [3, 4]}
list: [get, list, "watch"]
emptyMap: {}
emptyList: []
`);
    expectEqual(doc, {
      map: { a: 1, b: 'two', c: [3, 4] },
      list: ['get', 'list', 'watch'],
      emptyMap: {},
      emptyList: [],
    });
  });

  check('multi-line flow collection', () => {
    const doc = parseDocument(`
subjects: [
  {kind: User, name: alice},
  {kind: Group, name: devs}
]
`);
    expectEqual(doc, {
      subjects: [
        { kind: 'User', name: 'alice' },
        { kind: 'Group', name: 'devs' },
      ],
    });
  });

  check('double-quoted escapes', () => {
    const doc = parseDocument('text: "line\\nnext\\t\\"quoted\\""\n');
    expectEqual(doc, { text: 'line\nnext\t"quoted"' });
  });

  check('keys with dots and slashes', () => {
    const doc = parseDocument(`
app.kubernetes.io/name: web
requests.cpu: 100m
`);
    expectEqual(doc, { 'app.kubernetes.io/name': 'web', 'requests.cpu': '100m' });
  });

  check('template placeholders are plain strings', () => {
    const doc = parseDocument('replicas: "${{REPLICAS}}"\nname: ${APP_NAME}\n');
    expectEqual(doc, { replicas: '${{REPLICAS}}', name: '${APP_NAME}' });
  });

  check('invalid indentation raises a structured error with a line', () => {
    try {
      parseYaml('spec:\n  a: 1\n   b: 2\n');
      return false;
    } catch (err) {
      return err.name === 'YamlParseError' && err.line === 3 && typeof err.message === 'string';
    }
  });

  check('unterminated quote raises an error', () => {
    try {
      parseYaml('name: "oops\n');
      return false;
    } catch (err) {
      return err.name === 'YamlParseError';
    }
  });

  check('stringify simple map', () => {
    const value = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'web', labels: { app: 'web' } },
      spec: { replicas: 2 },
    };
    const text = stringifyYaml(value);
    expectEqual(parseDocument(text), value);
    return text.includes('apiVersion: apps/v1') && text.includes('kind: Deployment');
  });

  check('stringify sequence of mappings', () => {
    const value = {
      spec: {
        containers: [
          { name: 'main', image: 'nginx:latest', ports: [{ containerPort: 8080 }] },
          { name: 'sidecar', image: 'busybox', args: ['sh', '-c', 'sleep 1'] },
        ],
      },
    };
    expectEqual(parseDocument(stringifyYaml(value)), value);
  });

  check('stringify preserves tricky strings', () => {
    const value = {
      a: 'true',
      b: '123',
      c: 'has: colon',
      d: '#hash',
      e: ' padded ',
      f: '',
      g: null,
      h: 'multi\nline\n',
      i: 'multi\nline',
      j: 'ends with colon:',
    };
    expectEqual(parseDocument(stringifyYaml(value)), value);
  });

  check('stringify multi-document round trip', () => {
    const docs = [
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'web', namespace: 'demo' },
        spec: { ports: [{ port: 8080, targetPort: 8080 }] },
      },
      {
        apiVersion: 'route.openshift.io/v1',
        kind: 'Route',
        metadata: { name: 'web' },
        spec: { to: { kind: 'Service', name: 'web' } },
      },
    ];
    const text = docs.map((d) => `---\n${stringifyYaml(d)}`).join('');
    expectEqual(parseYaml(text), docs);
  });

  check('realistic deployment manifest', () => {
    const doc = parseDocument(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: webapp
  labels:
    app: webapp
spec:
  replicas: 2
  selector:
    matchLabels:
      app: webapp
  template:
    metadata:
      labels:
        app: webapp
    spec:
      containers:
        - name: webapp
          image: quay.io/openshift/origin-hello-openshift:latest
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
`);
    return (
      doc.kind === 'Deployment' &&
      doc.spec.template.spec.containers[0].ports[0].containerPort === 8080
    );
  });

  check('JSON documents and root flow collections', () => {
    expectEqual(parseDocument('{\n  "a": 1,\n  "b": [2, 3]\n}'), { a: 1, b: [2, 3] });
    expectEqual(parseDocument('[1, 2, 3]'), [1, 2, 3]);
    expectEqual(parseDocument('containers:\n  - {name: main}\n  - [a, b]\n'), {
      containers: [{ name: 'main' }, ['a', 'b']],
    });
  });

  check('root scalar document', () => {
    expectEqual(parseDocument('42\n'), 42);
    expectEqual(parseDocument('hello\n'), 'hello');
  });

  check('block scalar content may start with a tab', () => {
    expectEqual(parseDocument('a: |\n  \tfoo\n  bar\n'), { a: '\tfoo\nbar\n' });
  });

  check('multi-line flow collection may contain comments', () => {
    expectEqual(parseDocument('labels: {\n  app: web, # trailing comment\n  env: prod\n}\n'), {
      labels: { app: 'web', env: 'prod' },
    });
  });

  check('bare sequence item followed by a sibling is null, not nested', () => {
    expectEqual(parseDocument('a:\n  -\n  - x\n'), { a: [null, 'x'] });
  });

  check('folded block scalar keeps more-indented lines literal', () => {
    expectEqual(parseDocument('a: >\n  foo\n    bar\n  baz\n'), { a: 'foo\n  bar\nbaz\n' });
  });

  check('stringify empty collections', () => {
    expectEqual(parseDocument(stringifyYaml({ a: {}, b: [] })), { a: {}, b: [] });
  });

  return { ok: failures.length === 0, failures };
}

export default {
  parseYaml,
  parseDocument,
  parseYamlSafe,
  stringifyYaml,
  selfTest,
  toYamlError,
  YamlParseError,
};
