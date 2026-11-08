/**
 * LinuxCommands — the RHEL 9 workstation commands of the simulated shell (1.16.0).
 *
 * These `_cmd_<name>` handlers are mixed into ShellTools.prototype (see the bottom of
 * js/ui/ShellTools.js), so `this` is the ShellTools instance: `this.host` is the
 * LinuxHost model (js/engine/LinuxHost.js), `this._user()` the effective user (sudo-aware),
 * `this.bar` the CommandBar. Every handler returns `{error, message, exitCode}` with the
 * real RHEL 9 wording and exit status; stdout of a command that "fails" with a status
 * (`systemctl is-active` → `inactive`, exit 3) is returned as `error: false` + exitCode so it
 * prints normally while `$?`/`&&` see the status.
 *
 * DOM-free. Grading never parses this output; objectives read LinuxHost state.
 */

import {
  HOME,
  KERNEL_RELEASE,
  KERNEL_VERSION,
  RHEL_VERSION,
  WORKSTATION_IP,
  DNS_SERVER_IP,
  API_VIP,
  INGRESS_VIP,
  CLUSTER_DOMAIN,
  REPOS,
  FIREWALL_SERVICES,
  SIGNAL_NAMES,
  MIRROR_PREFIX,
  errnoText,
  modeString,
  octalMode,
  formatLsTime,
  formatJournalTime,
  formatSystemdTime,
  formatDate,
  formatRpmTime,
  formatStatTime,
  formatClock,
  formatRelative,
  humanSize,
  normalizePath,
  basenameOf,
  dirnameOf,
  collateNames,
  byteLength,
  fnv1a,
  fakeSha256,
  imageDigest,
  vfsKeyFor,
} from '../engine/LinuxHost.js';

/** Command names the shell runs without an `oc` prefix (added to SHELL_COMMANDS). */
export const LINUX_COMMANDS = [
  'cd',
  'mkdir',
  'rmdir',
  'less',
  'more',
  'tee',
  'find',
  'stat',
  'du',
  'df',
  'printf',
  'tar',
  'ln',
  'file',
  'diff',
  'whoami',
  'id',
  'groups',
  'sudo',
  'su',
  'chmod',
  'chown',
  'chgrp',
  'umask',
  'useradd',
  'usermod',
  'userdel',
  'groupadd',
  'groupdel',
  'passwd',
  'getenforce',
  'setenforce',
  'sestatus',
  'restorecon',
  'chcon',
  'semanage',
  'hostname',
  'hostnamectl',
  'timedatectl',
  'chronyc',
  'uname',
  'date',
  'uptime',
  'free',
  'history',
  'man',
  'type',
  'ps',
  'pgrep',
  'pkill',
  'kill',
  'killall',
  'top',
  'systemctl',
  'journalctl',
  'ip',
  'ss',
  'ping',
  'dig',
  'host',
  'nslookup',
  'getent',
  'firewall-cmd',
  'nmcli',
  'dnf',
  'yum',
  'rpm',
  'podman',
  'bash',
  'sh',
  'source',
  '.',
  'logout',
  'nano',
  'basename',
  'dirname',
  'sleep',
  'httpd',
  'apachectl',
  'sshd',
  'tree',
  'git',
  'wget',
  'lsof',
  'nc',
  'awk',
  'xargs',
  'realpath',
  'readlink',
  'w',
  'who',
  'gzip',
  'gunzip',
  'zcat',
  'test',
  '[',
  '[[',
  'alias',
  'll',
];

// ─── small helpers ──────────────────────────────────────────────────────────

const ok = (message = '') => ({ error: false, message, exitCode: 0 });
const fail = (message, exitCode = 1) => ({ error: true, message, exitCode });
/** stdout that comes with a non-zero status (`systemctl is-active`, `grep` style). */
const withStatus = (message, exitCode) =>
  exitCode === 0
    ? ok(message)
    : message
      ? { error: false, message, exitCode }
      : { error: true, message: '', exitCode, silentFailure: true };

/**
 * Split argv into short flag letters, long options and positionals. `valueShort` lists the
 * short options that take a value (`-n 5`, `-n5`), `valueLong` the long ones (`--since x`).
 */
function parseArgs(args, { valueShort = '', valueLong = [] } = {}) {
  const flags = new Set();
  const values = new Map();
  const longs = new Map();
  const positionals = [];
  let rest = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (rest || arg === '-' || !arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      rest = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
      if (eq > 0) longs.set(name, arg.slice(eq + 1));
      else if (valueLong.includes(name)) longs.set(name, args[++index] ?? '');
      else longs.set(name, true);
      continue;
    }
    const cluster = arg.slice(1);
    for (let position = 0; position < cluster.length; position += 1) {
      const letter = cluster[position];
      if (valueShort.includes(letter)) {
        const attached = cluster.slice(position + 1);
        values.set(letter, attached || (args[++index] ?? ''));
        break;
      }
      flags.add(letter);
    }
  }
  return { flags, values, longs, positionals };
}

/** Left/right aligned columns separated by `gap` (tabwriter-like). */
function table(rows, { align = [], gap = '  ', trim = true } = {}) {
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] || 0, String(cell ?? '').length);
    });
  }
  return rows
    .map((row) => {
      const line = row
        .map((cell, index) => {
          const text = String(cell ?? '');
          if (index === row.length - 1 && align[index] !== 'right') return text;
          return align[index] === 'right'
            ? text.padStart(widths[index])
            : text.padEnd(widths[index]);
        })
        .join(gap);
      return trim ? line.replace(/\s+$/, '') : line;
    })
    .join('\n');
}

/** Go's units.HumanDuration (podman CREATED/STATUS). */
function humanDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 1) return 'Less than a second';
  if (seconds === 1) return '1 second';
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes === 1) return 'About a minute';
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(seconds / 3600);
  if (hours === 1) return 'About an hour';
  if (hours < 48) return `${hours} hours`;
  if (hours < 24 * 7 * 2) return `${Math.floor(hours / 24)} days`;
  if (hours < 24 * 30 * 2) return `${Math.floor(hours / 24 / 7)} weeks`;
  if (hours < 24 * 365 * 2) return `${Math.floor(hours / 24 / 30)} months`;
  return `${Math.floor(hours / 24 / 365)} years`;
}

/** `[student@workstation …]` sudo-style quoting helper for messages. */
const q = (text) => `'${text}'`;
/** coreutils `quote()` in a UTF-8 locale (mkdir, id, chown invalid user). */
const cq = (text) => `‘${text}’`;

/** XFS-like directory size: small inline directories report their entry bytes. */
function dirSize(host, path) {
  const names = host._childNames(path);
  const size = 6 + names.reduce((sum, name) => sum + name.length + 8, 0);
  return size > 2048 ? 4096 * Math.ceil(size / 4096) : size;
}

function nodeSize(host, path, node) {
  if (node.type === 'dir') return dirSize(host, path);
  if (node.type === 'link') return byteLength(node.target);
  if (node.type === 'char' || node.type === 'block') return 0;
  if (Number.isFinite(node.size) && (node.binary || node.vfs)) return node.size;
  if (node.generator) {
    if (path.startsWith('/proc/')) return 0;
    return byteLength(host._content(path, node));
  }
  return byteLength(node.content ?? '');
}

function linkCount(host, path, node) {
  if (node.type !== 'dir') return 1;
  let count = 2;
  for (const name of host._childNames(path)) {
    const child = host._lookup(`${path === '/' ? '' : path}/${name}`);
    if (child && child.type === 'dir') count += 1;
  }
  return count;
}

const PODMAN_VERSION = '5.4.0';

export const LINUX_COMMAND_METHODS = {
  // ── navigation ───────────────────────────────────────────────────────────

  _cmd_cd(args) {
    const host = this.host;
    const operands = args.filter((arg) => arg !== '--' && arg !== '-L' && arg !== '-P');
    if (operands.length > 1) return fail('bash: cd: too many arguments');
    let target = operands[0];
    let printNew = false;
    if (target === undefined || target === '') target = host.homeOf(host.session.user);
    else if (target === '-') {
      if (!host.session.oldpwd) return fail('bash: cd: OLDPWD not set');
      target = host.session.oldpwd;
      printNew = true;
    }
    const changed = host.chdir(target, { user: this._user() });
    if (!changed.ok) return fail(`bash: cd: ${operands[0] ?? target}: ${errnoText(changed.error)}`);
    return ok(printNew ? changed.path : '');
  },

  _cmd_pwd() {
    return ok(this.host.session.cwd);
  },

  // ── listing ──────────────────────────────────────────────────────────────

  _cmd_ls(args) {
    const host = this.host;
    const { flags, longs, positionals } = parseArgs(args);
    if (longs.has('all')) flags.add('a');
    if (longs.has('almost-all')) flags.add('A');
    if (longs.has('human-readable')) flags.add('h');
    if (longs.has('directory')) flags.add('d');
    if (longs.has('recursive')) flags.add('R');
    if (longs.has('context')) flags.add('Z');
    if (longs.has('classify')) flags.add('F');
    if (longs.has('inode')) flags.add('i');
    const long = flags.has('l') || flags.has('n') || flags.has('g') || flags.has('o');
    const user = this._user();
    const targets = positionals.length ? positionals : ['.'];
    const out = [];
    let exitCode = 0;
    const errors = [];
    const sizeText = (path, node) => {
      if (node.type === 'char' || node.type === 'block')
        return `${node.rdev?.[0] ?? 1}, ${node.rdev?.[1] ?? 3}`;
      const size = nodeSize(host, path, node);
      return flags.has('h') ? humanSize(size) : String(size);
    };
    const now = host.now();
    const entryLine = (name, path, node, widths) => {
      const parts = [];
      if (flags.has('i'))
        parts.push(String(100000 + (fnv1a(path) % 9000000)).padStart(widths.ino || 0));
      if (long) {
        const mode = `${modeString(node.type, node.mode)}${node.context ? '.' : ''}`;
        const fields = [mode, String(linkCount(host, path, node)).padStart(widths.links)];
        const owner = flags.has('n') ? String(node.uid) : host.userName(node.uid);
        const group = flags.has('n') ? String(node.gid) : host.groupName(node.gid);
        if (!flags.has('g')) fields.push(owner.padEnd(widths.owner));
        if (!flags.has('o')) fields.push(group.padEnd(widths.group));
        if (flags.has('Z')) fields.push(String(node.context || '?').padEnd(widths.context));
        fields.push(sizeText(path, node).padStart(widths.size));
        fields.push(formatLsTime(node.mtime ?? now, now));
        let display = name;
        if (flags.has('F') || flags.has('p')) display += classify(node, flags.has('p'));
        if (node.type === 'link') display += ` -> ${node.target}`;
        fields.push(display);
        parts.push(fields.join(' '));
        return parts.join(' ');
      }
      let display = name;
      if (flags.has('F') || flags.has('p')) display += classify(node, flags.has('p'));
      else if (node.type === 'dir' && !flags.has('d') && !flags.has('1')) display += '/';
      if (flags.has('Z')) parts.push(`${node.context || '?'} ${display}`);
      else parts.push(display);
      return parts.join(' ');
    };
    const classify = (node, dirsOnly) => {
      if (node.type === 'dir') return '/';
      if (dirsOnly) return '';
      if (node.type === 'link') return '@';
      if (node.type === 'file' && node.mode & 0o111) return '*';
      return '';
    };
    const widthsFor = (entries) => {
      const widths = { links: 1, owner: 1, group: 1, size: 1, context: 1, ino: 1 };
      for (const { path, node } of entries) {
        widths.links = Math.max(widths.links, String(linkCount(host, path, node)).length);
        widths.owner = Math.max(
          widths.owner,
          (flags.has('n') ? String(node.uid) : host.userName(node.uid)).length
        );
        widths.group = Math.max(
          widths.group,
          (flags.has('n') ? String(node.gid) : host.groupName(node.gid)).length
        );
        widths.size = Math.max(widths.size, sizeText(path, node).length);
        widths.context = Math.max(widths.context, String(node.context || '?').length);
        widths.ino = Math.max(widths.ino, String(100000 + (fnv1a(path) % 9000000)).length);
      }
      return widths;
    };
    const sortEntries = (entries) => {
      const sorted = [...entries];
      if (flags.has('t'))
        sorted.sort(
          (a, b) => (b.node.mtime || 0) - (a.node.mtime || 0) || collateNames(a.name, b.name)
        );
      else if (flags.has('S'))
        sorted.sort(
          (a, b) =>
            nodeSize(host, b.path, b.node) - nodeSize(host, a.path, a.node) ||
            collateNames(a.name, b.name)
        );
      else if (!flags.has('U') && !flags.has('f'))
        sorted.sort((a, b) => collateNames(a.name, b.name));
      if (flags.has('r')) sorted.reverse();
      return sorted;
    };
    const listDirectory = (label, path, header) => {
      const listing = host.readdir(path, { user });
      if (!listing.ok) {
        errors.push(`ls: cannot open directory ${q(label)}: ${errnoText(listing.error)}`);
        exitCode = 2;
        return;
      }
      let entries = listing.entries;
      if (!flags.has('a') && !flags.has('A') && !flags.has('f'))
        entries = entries.filter((entry) => !entry.name.startsWith('.'));
      if (flags.has('a') || flags.has('f')) {
        const parentPath = dirnameOf(listing.path);
        entries = [
          { name: '.', path: listing.path, node: listing.node },
          { name: '..', path: parentPath, node: host._lookup(parentPath) || listing.node },
          ...entries,
        ];
      }
      entries = sortEntries(entries);
      if (header) out.push(`${label}:`);
      if (long) {
        const total = entries.reduce((sum, entry) => {
          if (entry.node.type !== 'file') return sum;
          const size = nodeSize(host, entry.path, entry.node);
          return sum + (size > 0 ? 4 * Math.ceil(size / 4096) : 0);
        }, 0);
        out.push(`total ${flags.has('h') ? humanSize(total * 1024) : total}`);
      }
      const widths = widthsFor(entries);
      for (const entry of entries) out.push(entryLine(entry.name, entry.path, entry.node, widths));
      if (flags.has('R')) {
        for (const entry of entries) {
          if (entry.name === '.' || entry.name === '..') continue;
          if (entry.node.type !== 'dir') continue;
          out.push('');
          const childLabel =
            label === '.' ? `./${entry.name}` : `${label.replace(/\/+$/, '')}/${entry.name}`;
          listDirectory(childLabel, entry.path, true);
        }
      }
    };
    const fileOperands = [];
    const dirOperands = [];
    for (const target of targets) {
      const followed = host.stat(target, { user, follow: true });
      const linkStat = host.stat(target, { user, follow: false });
      if (!followed.ok && !linkStat.ok) {
        errors.push(`ls: cannot access ${q(target)}: ${errnoText(followed.error)}`);
        exitCode = 2;
        continue;
      }
      const useLink =
        linkStat.ok &&
        linkStat.node.type === 'link' &&
        (long || flags.has('d')) &&
        !target.endsWith('/');
      const stat = useLink || !followed.ok ? linkStat : followed;
      if (stat.node.type === 'dir' && !flags.has('d'))
        dirOperands.push({ target, path: stat.path });
      else fileOperands.push({ name: target, path: stat.path, node: stat.node });
    }
    if (fileOperands.length) {
      const sorted = sortEntries(fileOperands);
      const widths = widthsFor(sorted);
      for (const entry of sorted) out.push(entryLine(entry.name, entry.path, entry.node, widths));
    }
    const multiple = targets.length > 1 || flags.has('R');
    dirOperands.forEach((entry, index) => {
      if (index > 0 || fileOperands.length) out.push('');
      listDirectory(entry.target, entry.path, multiple);
    });
    if (errors.length) {
      const message = [...errors, ...out].join('\n');
      return { error: true, message, exitCode };
    }
    return ok(out.join('\n'));
  },

  // ── create / remove / copy / move ────────────────────────────────────────

  _cmd_mkdir(args) {
    const { flags, values, longs, positionals } = parseArgs(args, { valueShort: 'm' });
    if (!positionals.length)
      return fail("mkdir: missing operand\nTry 'mkdir --help' for more information.");
    const parents = flags.has('p') || longs.has('parents');
    const verbose = flags.has('v') || longs.has('verbose');
    const mode = values.has('m') ? Number.parseInt(values.get('m'), 8) : undefined;
    const out = [];
    const errors = [];
    for (const dir of positionals) {
      const made = this.host.mkdir(dir, { user: this._user(), parents, mode });
      if (verbose)
        for (const path of made.created || [])
          out.push(`mkdir: created directory ${q(this._displayPath(dir, path))}`);
      if (made.error) {
        if (made.error === 'EEXIST' && parents) continue;
        errors.push(`mkdir: cannot create directory ${cq(dir)}: ${errnoText(made.error)}`);
      }
    }
    this._refreshFilesPanel();
    if (errors.length) return fail([...out, ...errors].join('\n'));
    return ok(out.join('\n'));
  },

  /** Echo a created path the way the user typed its prefix. */
  _displayPath(typed, abs) {
    const resolved = this.host.resolvePath(typed);
    if (resolved === abs) return typed;
    return abs;
  },

  _cmd_rmdir(args) {
    const { flags, positionals } = parseArgs(args);
    if (!positionals.length)
      return fail("rmdir: missing operand\nTry 'rmdir --help' for more information.");
    const errors = [];
    for (const dir of positionals) {
      const chain = [dir];
      if (flags.has('p')) {
        let current = dir.replace(/\/+$/, '');
        while (current.includes('/')) {
          current = current.slice(0, current.lastIndexOf('/'));
          if (current) chain.push(current);
        }
      }
      for (const path of chain) {
        const removed = this.host.rmdir(path, { user: this._user() });
        if (removed.error) {
          errors.push(`rmdir: failed to remove ${q(path)}: ${errnoText(removed.error)}`);
          break;
        }
      }
    }
    this._refreshFilesPanel();
    return errors.length ? fail(errors.join('\n')) : ok('');
  },

  _cmd_touch(args) {
    const { positionals } = parseArgs(args, { valueShort: 'dtr' });
    if (!positionals.length)
      return fail("touch: missing file operand\nTry 'touch --help' for more information.");
    const errors = [];
    for (const file of positionals) {
      const touched = this.host.touch(file, { user: this._user() });
      if (touched.error) errors.push(`touch: cannot touch ${q(file)}: ${errnoText(touched.error)}`);
    }
    this._refreshFilesPanel();
    return errors.length ? fail(errors.join('\n')) : ok('');
  },

  _cmd_rm(args) {
    const { flags, longs, positionals } = parseArgs(args);
    const force = flags.has('f') || longs.has('force');
    const recursive = flags.has('r') || flags.has('R') || longs.has('recursive');
    const verbose = flags.has('v');
    if (!positionals.length) {
      if (force) return ok('');
      return fail("rm: missing operand\nTry 'rm --help' for more information.");
    }
    const user = this._user();
    const errors = [];
    const out = [];
    for (const target of positionals) {
      const found = this.host.stat(target, { user, follow: false });
      if (!found.ok) {
        if (force && found.error === 'ENOENT') continue;
        errors.push(`rm: cannot remove ${q(target)}: ${errnoText(found.error)}`);
        continue;
      }
      if (found.node.type === 'dir') {
        if (!recursive) {
          errors.push(`rm: cannot remove ${q(target)}: Is a directory`);
          continue;
        }
        if (['/', HOME, '/tmp'].includes(found.path) && found.path === '/') {
          errors.push(
            `rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe`
          );
          continue;
        }
        const removed = this.host.removeTree(target, { user });
        for (const path of removed.removed || []) if (verbose) out.push(`removed ${q(path)}`);
        for (const entry of removed.errors || []) {
          const shown = entry.path === found.path ? target : entry.path;
          if (entry.op === 'opendir')
            errors.push(`rm: cannot remove ${q(shown)}: ${errnoText(entry.error)}`);
          else if (entry.error === 'EBUSY')
            errors.push(`rm: cannot remove ${q(shown)}: Device or resource busy`);
          else errors.push(`rm: cannot remove ${q(shown)}: ${errnoText(entry.error)}`);
        }
        continue;
      }
      const removed = this.host.unlink(target, { user });
      if (removed.error) errors.push(`rm: cannot remove ${q(target)}: ${errnoText(removed.error)}`);
      else if (verbose) out.push(`removed ${q(target)}`);
    }
    this._refreshFilesPanel();
    if (errors.length) return fail([...out, ...errors].join('\n'));
    return ok(out.join('\n'));
  },

  _cmd_cp(args) {
    const { flags, longs, positionals } = parseArgs(args);
    const recursive =
      flags.has('r') ||
      flags.has('R') ||
      flags.has('a') ||
      longs.has('recursive') ||
      longs.has('archive');
    const preserve =
      flags.has('a') || flags.has('p') || longs.has('archive') || longs.has('preserve');
    const verbose = flags.has('v');
    if (positionals.length < 2) {
      if (!positionals.length)
        return fail("cp: missing file operand\nTry 'cp --help' for more information.");
      return fail(
        `cp: missing destination file operand after ${q(positionals[0])}\nTry 'cp --help' for more information.`
      );
    }
    const destination = positionals[positionals.length - 1];
    const sources = positionals.slice(0, -1);
    const user = this._user();
    if (sources.length > 1) {
      const dest = this.host.stat(destination, { user });
      if (!dest.ok || dest.node.type !== 'dir')
        return fail(`cp: target ${q(destination)} is not a directory`);
    }
    const errors = [];
    const out = [];
    for (const source of sources) {
      const copied = this.host.copy(source, destination, { user, recursive, preserve });
      if (copied.ok) {
        if (verbose) out.push(`${q(source)} -> ${q(copied.path)}`);
        continue;
      }
      if (copied.error === 'OMIT_DIR')
        errors.push(`cp: -r not specified; omitting directory ${q(source)}`);
      else if (copied.error === 'SAME')
        errors.push(`cp: ${q(source)} and ${q(destination)} are the same file`);
      else if (copied.error === 'INTO_SELF')
        errors.push(`cp: cannot copy a directory, ${q(source)}, into itself, ${q(destination)}`);
      else if (copied.side === 'source' && copied.error === 'ENOENT')
        errors.push(`cp: cannot stat ${q(source)}: No such file or directory`);
      else if (copied.side === 'source')
        errors.push(`cp: cannot open ${q(copied.path)} for reading: ${errnoText(copied.error)}`);
      else if (copied.side === 'mkdir')
        errors.push(`cp: cannot create directory ${q(copied.path)}: ${errnoText(copied.error)}`);
      else
        errors.push(
          `cp: cannot create regular file ${q(this._shownDest(destination, copied.path))}: ${errnoText(copied.error)}`
        );
    }
    this._refreshFilesPanel();
    if (errors.length) return fail([...out, ...errors].join('\n'));
    return ok(out.join('\n'));
  },

  _shownDest(typed, abs) {
    const resolved = this.host.resolvePath(typed);
    if (abs === resolved) return typed;
    if (abs.startsWith(`${resolved}/`))
      return `${typed.replace(/\/+$/, '')}/${abs.slice(resolved.length + 1)}`;
    return typed;
  },

  _cmd_mv(args) {
    const { flags, positionals } = parseArgs(args);
    const verbose = flags.has('v');
    if (positionals.length < 2) {
      if (!positionals.length)
        return fail("mv: missing file operand\nTry 'mv --help' for more information.");
      return fail(
        `mv: missing destination file operand after ${q(positionals[0])}\nTry 'mv --help' for more information.`
      );
    }
    const destination = positionals[positionals.length - 1];
    const sources = positionals.slice(0, -1);
    const user = this._user();
    if (sources.length > 1) {
      const dest = this.host.stat(destination, { user });
      if (!dest.ok || dest.node.type !== 'dir')
        return fail(`mv: target ${q(destination)} is not a directory`);
    }
    const errors = [];
    const out = [];
    for (const source of sources) {
      const moved = this.host.rename(source, destination, { user });
      if (moved.ok) {
        if (verbose)
          out.push(`renamed ${q(source)} -> ${q(this._shownDest(destination, moved.path))}`);
        continue;
      }
      if (moved.side === 'source')
        errors.push(`mv: cannot stat ${q(source)}: ${errnoText(moved.error)}`);
      else if (moved.error === 'EINVAL')
        errors.push(`mv: cannot move ${q(source)} to a subdirectory of itself, ${q(destination)}`);
      else if (moved.error === 'EISDIR')
        errors.push(`mv: cannot overwrite directory ${q(destination)} with non-directory`);
      else
        errors.push(
          `mv: cannot move ${q(source)} to ${q(this._shownDest(destination, moved.path))}: ${errnoText(moved.error)}`
        );
    }
    this._refreshFilesPanel();
    if (errors.length) return fail([...out, ...errors].join('\n'));
    return ok(out.join('\n'));
  },

  _cmd_ln(args) {
    const { flags, positionals } = parseArgs(args);
    if (positionals.length < 1)
      return fail("ln: missing file operand\nTry 'ln --help' for more information.");
    const target = positionals[0];
    let link = positionals[1] ?? basenameOf(target);
    const user = this._user();
    const linkStat = this.host.stat(link, { user });
    if (linkStat.ok && linkStat.node.type === 'dir')
      link = `${link.replace(/\/+$/, '')}/${basenameOf(target)}`;
    if (flags.has('f')) {
      const existing = this.host.stat(link, { user, follow: false });
      if (existing.ok && existing.node.type !== 'dir') this.host.unlink(link, { user });
    }
    if (!flags.has('s')) {
      const source = this.host.stat(target, { user });
      if (!source.ok) return fail(`ln: failed to access ${q(target)}: ${errnoText(source.error)}`);
      const copied = this.host.copy(target, link, { user, preserve: true });
      if (copied.error)
        return fail(`ln: failed to create hard link ${q(link)}: ${errnoText(copied.error)}`);
      return ok('');
    }
    const made = this.host.symlink(target, link, { user });
    if (made.error)
      return fail(`ln: failed to create symbolic link ${q(link)}: ${errnoText(made.error)}`);
    return ok('');
  },

  _cmd_tee(args, stdin) {
    const { flags, longs, positionals } = parseArgs(args);
    const append = flags.has('a') || longs.has('append');
    const text = stdin === null ? '' : String(stdin);
    const data = text && !text.endsWith('\n') ? `${text}\n` : text;
    const errors = [];
    for (const file of positionals) {
      const written = this.host.writeFile(file, data, { user: this._user(), append });
      if (written.error) errors.push(`tee: ${file}: ${errnoText(written.error)}`);
    }
    this._refreshFilesPanel();
    if (errors.length)
      return {
        error: true,
        message: [text.replace(/\n$/, ''), ...errors].filter(Boolean).join('\n'),
        exitCode: 1,
      };
    return ok(text.replace(/\n$/, ''));
  },

  _cmd_less(args, stdin) {
    const files = args.filter((arg) => !arg.startsWith('-') && !arg.startsWith('+'));
    if (!files.length) {
      if (stdin === null) return fail('Missing filename ("less --help" for help)');
      return ok(String(stdin).replace(/\n$/, ''));
    }
    const chunks = [];
    for (const file of files) {
      const read = this._readFileResult(file);
      if (!read.ok) {
        if (read.error === 'EISDIR') return fail(`${file} is a directory`);
        return fail(`${file}: ${errnoText(read.error)}`);
      }
      chunks.push(read.content.replace(/\n$/, ''));
    }
    return ok(chunks.join('\n'));
  },

  _cmd_more(args, stdin) {
    const files = args.filter((arg) => !arg.startsWith('-') && !arg.startsWith('+'));
    if (!files.length) {
      if (stdin === null) return fail("more: bad usage\nTry 'more --help' for more information.");
      return ok(String(stdin).replace(/\n$/, ''));
    }
    const chunks = [];
    for (const file of files) {
      const read = this._readFileResult(file);
      if (!read.ok) {
        if (read.error === 'EISDIR') return fail(`\n*** ${file}: directory ***\n`);
        return fail(`more: cannot open ${file}: ${errnoText(read.error)}`);
      }
      if (files.length > 1) chunks.push(`::::::::::::::\n${file}\n::::::::::::::`);
      chunks.push(read.content.replace(/\n$/, ''));
    }
    return ok(chunks.join('\n'));
  },

  // ── inspect files ────────────────────────────────────────────────────────

  _cmd_stat(args) {
    const { flags, values, longs, positionals } = parseArgs(args, {
      valueShort: 'c',
      valueLong: ['format', 'printf'],
    });
    if (!positionals.length)
      return fail("stat: missing operand\nTry 'stat --help' for more information.");
    const host = this.host;
    const format = values.get('c') ?? longs.get('format') ?? longs.get('printf') ?? null;
    const follow = flags.has('L');
    const out = [];
    const errors = [];
    const typeName = (node, size) =>
      node.type === 'dir'
        ? 'directory'
        : node.type === 'link'
          ? 'symbolic link'
          : node.type === 'char'
            ? 'character special file'
            : node.type === 'block'
              ? 'block special file'
              : size === 0
                ? 'regular empty file'
                : 'regular file';
    for (const target of positionals) {
      const found = host.stat(target, { user: this._user(), follow });
      if (!found.ok) {
        errors.push(`stat: cannot statx ${q(target)}: ${errnoText(found.error)}`);
        continue;
      }
      const node = found.node;
      const size = nodeSize(host, found.path, node);
      const blocks = node.type === 'file' && size > 0 ? 8 * Math.ceil(size / 4096) : 0;
      const ino = 100000 + (fnv1a(found.path) % 90000000);
      const owner = host.userName(node.uid);
      const group = host.groupName(node.gid);
      if (format !== null && format !== true) {
        out.push(
          String(format).replace(/%([a-zA-Z%])/g, (match, code) => {
            switch (code) {
              case 'a':
                return (node.mode & 0o7777).toString(8);
              case 'A':
                return modeString(node.type, node.mode);
              case 'U':
                return owner;
              case 'G':
                return group;
              case 'u':
                return String(node.uid);
              case 'g':
                return String(node.gid);
              case 's':
                return String(size);
              case 'n':
                return target;
              case 'F':
                return typeName(node, size);
              case 'C':
                return node.context || '?';
              case 'i':
                return String(ino);
              case 'h':
                return String(linkCount(host, found.path, node));
              case 'y':
                return formatStatTime(node.mtime ?? host.now());
              case 'Y':
                return String(Math.floor((node.mtime ?? host.now()) / 1000));
              case 'b':
                return String(blocks);
              case '%':
                return '%';
              default:
                return match;
            }
          })
        );
        continue;
      }
      const time = formatStatTime(node.mtime ?? host.now());
      const name = node.type === 'link' ? `${target} -> ${node.target}` : target;
      const ioBlock = 4096;
      out.push(
        `  File: ${name}`,
        `  Size: ${String(size).padEnd(10)}\tBlocks: ${String(blocks).padEnd(10)} IO Block: ${String(ioBlock).padEnd(6)} ${typeName(node, size)}`,
        node.type === 'char' || node.type === 'block'
          ? `Device: 5h/5d\tInode: ${String(ino).padEnd(11)} Links: 1     Device type: ${node.rdev?.[0] ?? 1},${node.rdev?.[1] ?? 3}`
          : `Device: fd04h/64772d\tInode: ${String(ino).padEnd(11)} Links: ${linkCount(host, found.path, node)}`,
        `Access: (${octalMode(node.mode)}/${modeString(node.type, node.mode)})  Uid: (${String(node.uid).padStart(5)}/${owner.padStart(8)})   Gid: (${String(node.gid).padStart(5)}/${group.padStart(8)})`,
        `Context: ${node.context || '?'}`,
        `Access: ${formatStatTime(Math.max(node.mtime ?? host.now(), host.bootTime))}`,
        `Modify: ${time}`,
        `Change: ${time}`,
        ` Birth: ${time}`
      );
    }
    if (errors.length) return fail([...out, ...errors].join('\n'));
    return ok(out.join('\n'));
  },

  _cmd_file(args) {
    const { positionals } = parseArgs(args);
    if (!positionals.length)
      return fail(
        'Usage: file [-bcCdEhikLlNnprsSvzZ0] [--apple] [--extension] [--mime-encoding]\n            [--mime-type] [-e <testname>] [-F <separator>]  [-f <namefile>]\n            [-m <magicfiles>] [-P <parameter=value>] [--exclude-quiet]\n            <file> ...\n       file -C [-m <magicfiles>]\n       file [--help]'
      );
    const out = [];
    for (const target of positionals) {
      const found = this.host.stat(target, { user: this._user(), follow: false });
      if (!found.ok) {
        out.push(`${target}: cannot open \`${target}' (${errnoText(found.error)})`);
        continue;
      }
      const node = found.node;
      let description;
      if (node.type === 'dir') description = 'directory';
      else if (node.type === 'link') description = `symbolic link to ${node.target}`;
      else if (node.type === 'char')
        description = `character special (${node.rdev?.[0] ?? 1}/${node.rdev?.[1] ?? 3})`;
      else if (node.type === 'block')
        description = `block special (${node.rdev?.[0] ?? 252}/${node.rdev?.[1] ?? 0})`;
      else if (node.binary) {
        description = `ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2, BuildID[sha1]=${fakeSha256(found.path).slice(0, 40)}, for GNU/Linux 3.2.0, stripped`;
      } else {
        const read = this._readFileResult(target);
        if (!read.ok) {
          out.push(`${target}: regular file, no read permission`);
          continue;
        }
        description = describeContent(read.content);
      }
      out.push(`${target}: ${description}`);
    }
    return ok(out.join('\n'));
  },

  _cmd_find(args) {
    const host = this.host;
    const user = this._user();
    const starts = [];
    let index = 0;
    while (index < args.length && !/^[-!(]/.test(args[index])) starts.push(args[index++]);
    if (!starts.length) starts.push('.');
    const tests = [];
    let maxDepth = Infinity;
    let minDepth = 0;
    let negate = false;
    const actions = [];
    for (; index < args.length; index += 1) {
      const arg = args[index];
      const next = () => args[++index];
      if (arg === '!' || arg === '-not') {
        negate = true;
        continue;
      }
      let test = null;
      if (arg === '-name' || arg === '-iname') {
        const pattern = next() ?? '';
        const regex = globRegex(pattern, arg === '-iname');
        test = (entry) => regex.test(entry.name);
      } else if (arg === '-path' || arg === '-wholename') {
        const regex = globRegex(next() ?? '', false, true);
        test = (entry) => regex.test(entry.shown);
      } else if (arg === '-type') {
        const kind = next();
        const map = { f: 'file', d: 'dir', l: 'link', c: 'char', b: 'block' };
        test = (entry) => entry.node.type === map[kind];
      } else if (arg === '-user') {
        const name = next();
        test = (entry) => host.userName(entry.node.uid) === name || String(entry.node.uid) === name;
      } else if (arg === '-group') {
        const name = next();
        test = (entry) =>
          host.groupName(entry.node.gid) === name || String(entry.node.gid) === name;
      } else if (arg === '-perm') {
        const spec = String(next() ?? '');
        const mode = (text) => Number.parseInt(text, 8);
        if (spec.startsWith('-'))
          test = (entry) => (entry.node.mode & mode(spec.slice(1))) === mode(spec.slice(1));
        else if (spec.startsWith('/'))
          test = (entry) => (entry.node.mode & mode(spec.slice(1))) !== 0;
        else if (/^[0-7]+$/.test(spec)) test = (entry) => (entry.node.mode & 0o7777) === mode(spec);
        else {
          const symbolic = spec.match(/^([ugoa]*)[=+-]?([rwx]+)$/);
          if (symbolic) {
            let bits = 0;
            const who = symbolic[1] || 'a';
            for (const target of who === 'a' ? 'ugo' : who) {
              const shift = { u: 6, g: 3, o: 0 }[target];
              for (const perm of symbolic[2]) bits |= { r: 4, w: 2, x: 1 }[perm] << shift;
            }
            test = (entry) => (entry.node.mode & bits) === bits;
          } else return fail(`find: invalid mode ${cq(spec)}`);
        }
      } else if (arg === '-maxdepth') {
        maxDepth = Number(next());
        continue;
      } else if (arg === '-mindepth') {
        minDepth = Number(next());
        continue;
      } else if (arg === '-empty') {
        test = (entry) =>
          entry.node.type === 'dir'
            ? host._childNames(entry.path).length === 0
            : nodeSize(host, entry.path, entry.node) === 0;
      } else if (arg === '-size') {
        const spec = String(next() ?? '');
        const match = spec.match(/^([+-]?)(\d+)([ckMG]?)$/);
        if (!match) return fail(`find: invalid -size type ${q(spec)}`);
        const unit = { c: 1, k: 1024, M: 1024 * 1024, G: 1024 ** 3, '': 512 }[match[3]];
        const wanted = Number(match[2]);
        test = (entry) => {
          const size = Math.ceil(nodeSize(host, entry.path, entry.node) / unit);
          return match[1] === '+'
            ? size > wanted
            : match[1] === '-'
              ? size < wanted
              : size === wanted;
        };
      } else if (arg === '-mmin' || arg === '-mtime') {
        const spec = String(next() ?? '0');
        const unitMs = arg === '-mmin' ? 60000 : 86400000;
        const value = Number(spec.replace(/^[+-]/, ''));
        test = (entry) => {
          const age = Math.floor((host.now() - (entry.node.mtime ?? 0)) / unitMs);
          return spec.startsWith('+')
            ? age > value
            : spec.startsWith('-')
              ? age < value
              : age === value;
        };
      } else if (arg === '-newer') {
        const ref = host.stat(next() ?? '', { user: 'root' });
        const mtime = ref.ok ? ref.node.mtime : Infinity;
        test = (entry) => (entry.node.mtime ?? 0) > mtime;
      } else if (arg === '-print') {
        continue;
      } else if (arg === '-exec') {
        const command = [];
        while (index + 1 < args.length && args[index + 1] !== ';' && args[index + 1] !== '+')
          command.push(args[++index]);
        index += 1;
        actions.push({ type: 'exec', command });
        continue;
      } else if (arg === '-delete') {
        actions.push({ type: 'delete' });
        continue;
      } else if (arg === '-ls') {
        actions.push({ type: 'ls' });
        continue;
      } else {
        return fail(`find: unknown predicate ${q(arg)}`);
      }
      if (test) {
        const inner = test;
        tests.push(negate ? (entry) => !inner(entry) : inner);
        negate = false;
      }
    }
    const results = [];
    const errors = [];
    const visit = (shown, path, node, depth) => {
      const entry = {
        shown,
        path,
        node,
        name: depth === 0 ? basenameOf(shown) || shown : basenameOf(path),
      };
      if (depth >= minDepth && tests.every((test) => test(entry))) results.push(entry);
      if (node.type !== 'dir' || depth >= maxDepth) return;
      const listing = host.readdir(path, { user });
      if (!listing.ok) {
        errors.push(`find: ${cq(shown)}: ${errnoText(listing.error)}`);
        return;
      }
      for (const child of listing.entries) {
        visit(
          `${shown === '/' ? '' : shown.replace(/\/+$/, '')}/${child.name}`,
          child.path,
          child.node,
          depth + 1
        );
      }
    };
    for (const start of starts) {
      const found = host.stat(start, { user, follow: true });
      if (!found.ok) {
        errors.push(`find: ${cq(start)}: ${errnoText(found.error)}`);
        continue;
      }
      visit(start, found.path, found.node, 0);
    }
    const out = [];
    for (const entry of results) {
      if (!actions.length) {
        out.push(entry.shown);
        continue;
      }
      for (const action of actions) {
        if (action.type === 'delete') {
          const removed =
            entry.node.type === 'dir'
              ? host.rmdir(entry.path, { user })
              : host.unlink(entry.path, { user });
          if (removed.error)
            errors.push(`find: cannot delete ${cq(entry.shown)}: ${errnoText(removed.error)}`);
        } else if (action.type === 'ls') {
          out.push(
            `${String(100000 + (fnv1a(entry.path) % 9000000)).padStart(9)}      ${String(4 * Math.ceil(nodeSize(host, entry.path, entry.node) / 4096)).padStart(1)} ${modeString(entry.node.type, entry.node.mode)}   1 ${host.userName(entry.node.uid).padEnd(8)} ${host.groupName(entry.node.gid).padEnd(8)} ${String(nodeSize(host, entry.path, entry.node)).padStart(8)} ${formatLsTime(entry.node.mtime ?? host.now(), host.now())} ${entry.shown}`
          );
        } else if (action.type === 'exec') {
          const argv = action.command.map((word) =>
            word === '{}' ? entry.shown : word.replace(/\{\}/g, entry.shown)
          );
          const result = this.runTokens(argv, null);
          if (result.message) out.push(String(result.message).replace(/\n$/, ''));
        }
      }
    }
    this._refreshFilesPanel();
    if (errors.length) return { error: true, message: [...out, ...errors].join('\n'), exitCode: 1 };
    return ok(out.join('\n'));
  },

  _cmd_du(args) {
    const host = this.host;
    const { flags, positionals, values } = parseArgs(args, { valueShort: 'd' });
    const human = flags.has('h');
    const summarize = flags.has('s');
    const all = flags.has('a');
    const maxDepth = values.has('d') ? Number(values.get('d')) : Infinity;
    const targets = positionals.length ? positionals : ['.'];
    const out = [];
    const errors = [];
    let grand = 0;
    const show = (kib, label) =>
      `${human ? (kib === 0 ? '0' : humanSize(kib * 1024)) : kib}\t${label}`;
    const visit = (label, path, node, depth) => {
      if (node.type !== 'dir') {
        const size = nodeSize(host, path, node);
        const kib = node.type === 'file' && size > 0 ? 4 * Math.ceil(size / 4096) : 0;
        if ((all || depth === 0) && !summarize && depth <= maxDepth) out.push(show(kib, label));
        return kib;
      }
      let total = 0;
      const listing = host.readdir(path, { user: this._user() });
      if (!listing.ok)
        errors.push(`du: cannot read directory ${q(label)}: ${errnoText(listing.error)}`);
      else {
        for (const child of listing.entries) {
          total += visit(
            `${label.replace(/\/+$/, '')}/${child.name}`,
            child.path,
            child.node,
            depth + 1
          );
        }
      }
      if (!summarize && depth <= maxDepth) out.push(show(total, label));
      return total;
    };
    for (const target of targets) {
      const found = host.stat(target, { user: this._user() });
      if (!found.ok) {
        errors.push(`du: cannot access ${q(target)}: ${errnoText(found.error)}`);
        continue;
      }
      const total = visit(target, found.path, found.node, 0);
      grand += total;
      if (summarize) out.push(show(total, target));
    }
    if (flags.has('c')) out.push(show(grand, 'total'));
    if (errors.length) return { error: true, message: [...errors, ...out].join('\n'), exitCode: 1 };
    return ok(out.join('\n'));
  },

  _cmd_df(args) {
    const { flags, positionals } = parseArgs(args);
    const rows = [
      ['devtmpfs', 'devtmpfs', 4096, 0, '/dev'],
      ['tmpfs', 'tmpfs', 1857484, 0, '/dev/shm'],
      ['tmpfs', 'tmpfs', 742996, 9832, '/run'],
      ['/dev/vda4', 'xfs', 10473452, 3301208, '/'],
      ['/dev/vda3', 'xfs', 983040, 244628, '/boot'],
      ['/dev/vda2', 'vfat', 204580, 7172, '/boot/efi'],
      ['tmpfs', 'tmpfs', 371496, 4, '/run/user/1000'],
    ];
    let selected = rows;
    if (positionals.length) {
      selected = [];
      for (const target of positionals) {
        const found = this.host.stat(target, { user: this._user() });
        if (!found.ok) return fail(`df: ${target}: ${errnoText(found.error)}`);
        const mount = [...rows]
          .sort((a, b) => b[4].length - a[4].length)
          .find(
            (row) =>
              found.path === row[4] || found.path.startsWith(`${row[4] === '/' ? '' : row[4]}/`)
          );
        if (mount && !selected.includes(mount)) selected.push(mount);
      }
    }
    const human = flags.has('h');
    const header = [
      'Filesystem',
      ...(flags.has('T') ? ['Type'] : []),
      human ? 'Size' : '1K-blocks',
      'Used',
      human ? 'Avail' : 'Available',
      'Use%',
      'Mounted on',
    ];
    const body = selected.map(([fs, type, size, used, mount]) => {
      const avail = size - used;
      const percent = size ? `${Math.ceil((used / size) * 100)}%` : '-';
      const fmt = (kib) => (human ? (kib === 0 ? '0' : humanSize(kib * 1024)) : String(kib));
      return [
        fs,
        ...(flags.has('T') ? [type] : []),
        fmt(size),
        fmt(used),
        fmt(avail),
        percent,
        mount,
      ];
    });
    const align = [
      'left',
      ...(flags.has('T') ? ['left'] : []),
      'right',
      'right',
      'right',
      'right',
      'left',
    ];
    return ok(table([header, ...body], { align, gap: ' ' }));
  },

  _cmd_printf(args) {
    if (!args.length) return fail('printf: usage: printf [-v var] format [arguments]', 2);
    const [format, ...values] = args;
    const output = formatPrintf(format, values);
    return { error: false, message: output.replace(/\n$/, ''), stdout: output, exitCode: 0 };
  },

  _cmd_basename(args) {
    const { positionals, flags } = parseArgs(args);
    if (!positionals.length)
      return fail("basename: missing operand\nTry 'basename --help' for more information.");
    if (flags.has('a')) return ok(positionals.map((path) => basenameOf(path)).join('\n'));
    let base = String(positionals[0]).replace(/\/+$/, '');
    base = base.slice(base.lastIndexOf('/') + 1) || '/';
    if (positionals[1] && base.endsWith(positionals[1]) && base !== positionals[1])
      base = base.slice(0, -positionals[1].length);
    return ok(base);
  },

  _cmd_dirname(args) {
    const { positionals } = parseArgs(args);
    if (!positionals.length)
      return fail("dirname: missing operand\nTry 'dirname --help' for more information.");
    return ok(
      positionals
        .map((path) => {
          const clean = String(path).replace(/\/+$/, '');
          if (!clean.includes('/')) return '.';
          return clean.slice(0, clean.lastIndexOf('/')) || '/';
        })
        .join('\n')
    );
  },

  _cmd_realpath(args) {
    const { positionals } = parseArgs(args);
    const out = [];
    for (const path of positionals) {
      const found = this.host.stat(path, { user: this._user() });
      if (!found.ok) return fail(`realpath: ${path}: ${errnoText(found.error)}`);
      out.push(found.path);
    }
    return ok(out.join('\n'));
  },

  _cmd_readlink(args) {
    const { flags, positionals } = parseArgs(args);
    const out = [];
    for (const path of positionals) {
      if (flags.has('f') || flags.has('e')) {
        const found = this.host.stat(path, { user: this._user() });
        if (!found.ok) return { error: true, message: '', exitCode: 1, silentFailure: true };
        out.push(found.path);
        continue;
      }
      const found = this.host.stat(path, { user: this._user(), follow: false });
      if (!found.ok || found.node.type !== 'link')
        return { error: true, message: '', exitCode: 1, silentFailure: true };
      out.push(found.node.target);
    }
    return ok(out.join('\n'));
  },

  _cmd_sleep(args) {
    if (!args.length)
      return fail("sleep: missing operand\nTry 'sleep --help' for more information.");
    return ok('');
  },

  _cmd_diff(args, stdin) {
    // `diff -f manifest.yaml` is the historical unprefixed `oc diff` form.
    if (
      args.some(
        (arg) =>
          arg === '-f' ||
          arg === '-k' ||
          arg.startsWith('--filename') ||
          arg.startsWith('--kustomize')
      )
    ) {
      return this.bar?._cmdDiff
        ? this.bar._cmdDiff(args, { stdin })
        : fail('diff: missing operand');
    }
    const { flags, positionals } = parseArgs(args);
    if (positionals.length < 2) {
      return fail(
        `diff: missing operand after ${q(positionals[0] ?? 'diff')}\ndiff: Try 'diff --help' for more information.`,
        2
      );
    }
    const [leftPath, rightPath] = positionals;
    const read = (path) =>
      path === '-' ? { ok: true, content: stdin ?? '' } : this._readFileResult(path);
    const left = read(leftPath);
    if (!left.ok) return fail(`diff: ${leftPath}: ${errnoText(left.error)}`, 2);
    const right = read(rightPath);
    if (!right.ok) return fail(`diff: ${rightPath}: ${errnoText(right.error)}`, 2);
    if (left.content === right.content) return ok('');
    if (flags.has('q')) return withStatus(`Files ${leftPath} and ${rightPath} differ`, 1);
    const unified = flags.has('u');
    const text = diffLines(left.content, right.content, {
      unified,
      leftLabel: `${leftPath}\t${formatStatTime(this.host.stat(leftPath, { user: 'root' }).node?.mtime ?? this.host.now())}`,
      rightLabel: `${rightPath}\t${formatStatTime(this.host.stat(rightPath, { user: 'root' }).node?.mtime ?? this.host.now())}`,
    });
    return withStatus(text, 1);
  },

  // ── identity & permissions ───────────────────────────────────────────────

  _cmd_whoami(args) {
    if (args.length)
      return fail(`whoami: extra operand ${q(args[0])}\nTry 'whoami --help' for more information.`);
    return ok(this._user());
  },

  _cmd_id(args) {
    const host = this.host;
    const { flags, positionals } = parseArgs(args);
    const name = positionals[0] ?? this._user();
    const user = host.users.get(name) || (/^\d+$/.test(name) ? host.userByUid(Number(name)) : null);
    if (!user) return fail(`id: ${cq(name)}: no such user`);
    const groups = host
      .groupsOf(user.name)
      .map((group) => ({ name: group, gid: host.groups.get(group)?.gid ?? group }));
    const context = 'unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023';
    if (flags.has('Z')) return ok(context);
    if (flags.has('u')) return ok(flags.has('n') ? user.name : String(user.uid));
    if (flags.has('g')) return ok(flags.has('n') ? groups[0].name : String(user.gid));
    if (flags.has('G'))
      return ok(groups.map((group) => (flags.has('n') ? group.name : String(group.gid))).join(' '));
    const primary = host.groupByGid(user.gid);
    let line = `uid=${user.uid}(${user.name}) gid=${user.gid}(${primary?.name ?? user.gid}) groups=${groups.map((group) => `${group.gid}(${group.name})`).join(',')}`;
    if (!positionals.length) line += ` context=${context}`;
    return ok(line);
  },

  _cmd_groups(args) {
    const host = this.host;
    if (!args.length) return ok(host.groupsOf(this._user()).join(' '));
    const out = [];
    for (const name of args) {
      if (!host.users.has(name)) return fail(`groups: ${cq(name)}: no such user`);
      out.push(`${name} : ${host.groupsOf(name).join(' ')}`);
    }
    return ok(out.join('\n'));
  },

  _cmd_chmod(args) {
    const { flags, positionals } = parseArgs(
      args.map((arg) => (/^[-+=][rwxXst]+$/.test(arg) ? `\u0000${arg}` : arg))
    );
    const operands = positionals.map((arg) => arg.replace(/^\u0000/, ''));
    const modeArg = args.find((arg) => /^[-+=][rwxXst]+$/.test(arg))
      ? operands.find((arg) => /^[-+=]/.test(arg))
      : null;
    const list = modeArg ? operands.filter((arg) => arg !== modeArg) : operands;
    const mode = modeArg ?? list.shift();
    if (mode === undefined)
      return fail("chmod: missing operand\nTry 'chmod --help' for more information.");
    if (!list.length)
      return fail(
        `chmod: missing operand after ${cq(mode)}\nTry 'chmod --help' for more information.`
      );
    const recursive = flags.has('R');
    const verbose = flags.has('v');
    const changesOnly = flags.has('c');
    const out = [];
    const errors = [];
    const user = this._user();
    const apply = (shown, target) => {
      const result = this.host.chmod(target, mode, { user });
      if (result.error === 'EINVAL_MODE') return 'invalid';
      if (result.error === 'EPERM') {
        errors.push(`chmod: changing permissions of ${q(shown)}: Operation not permitted`);
        return null;
      }
      if (result.error) {
        errors.push(`chmod: cannot access ${q(shown)}: ${errnoText(result.error)}`);
        return null;
      }
      const describe = (bits) => `${octalMode(bits)} (${modeString('file', bits).slice(1)})`;
      if (result.before !== result.after && (verbose || changesOnly))
        out.push(
          `mode of ${q(shown)} changed from ${describe(result.before)} to ${describe(result.after)}`
        );
      else if (verbose) out.push(`mode of ${q(shown)} retained as ${describe(result.after)}`);
      if (recursive && result.node.type === 'dir') {
        const listing = this.host.readdir(target, { user });
        if (listing.ok)
          for (const entry of listing.entries)
            apply(`${shown.replace(/\/+$/, '')}/${entry.name}`, entry.path);
      }
      return null;
    };
    for (const target of list) {
      if (apply(target, target) === 'invalid')
        return fail(`chmod: invalid mode: ${cq(mode)}\nTry 'chmod --help' for more information.`);
    }
    this._refreshFilesPanel();
    if (errors.length) return fail([...out, ...errors].join('\n'));
    return ok(out.join('\n'));
  },

  _cmd_chown(args) {
    return this._chownLike('chown', args);
  },

  _cmd_chgrp(args) {
    return this._chownLike('chgrp', args);
  },

  _chownLike(command, args) {
    const host = this.host;
    const { flags, positionals } = parseArgs(args);
    const spec = positionals.shift();
    if (spec === undefined)
      return fail(`${command}: missing operand\nTry '${command} --help' for more information.`);
    if (!positionals.length)
      return fail(
        `${command}: missing operand after ${cq(spec)}\nTry '${command} --help' for more information.`
      );
    let owner = null;
    let group = null;
    if (command === 'chgrp') group = spec;
    else {
      const sep = spec.search(/[:.]/);
      if (sep < 0) owner = spec;
      else {
        owner = spec.slice(0, sep) || null;
        group = spec.slice(sep + 1);
        if (group === '' && owner) group = host.groupName(host.users.get(owner)?.gid ?? 0);
        if (group === '') group = null;
      }
    }
    if (owner !== null && !host.users.has(owner) && !/^\d+$/.test(owner))
      return fail(`${command}: invalid user: ${cq(spec)}`);
    if (group !== null && !host.groups.has(group) && !/^\d+$/.test(group)) {
      return fail(
        command === 'chgrp'
          ? `chgrp: invalid group: ${cq(group)}`
          : `chown: invalid group: ${cq(spec)}`
      );
    }
    const recursive = flags.has('R');
    const verbose = flags.has('v');
    const out = [];
    const errors = [];
    const user = this._user();
    const apply = (shown, target) => {
      const result = host.chown(target, { owner, group }, { user, follow: !flags.has('h') });
      if (result.error === 'EPERM') {
        errors.push(
          command === 'chgrp'
            ? `chgrp: changing group of ${q(shown)}: Operation not permitted`
            : `chown: changing ownership of ${q(shown)}: Operation not permitted`
        );
        return;
      }
      if (result.error) {
        errors.push(`${command}: cannot access ${q(shown)}: ${errnoText(result.error)}`);
        return;
      }
      const name = (ids) =>
        command === 'chgrp'
          ? host.groupName(ids.gid)
          : `${host.userName(ids.uid)}:${host.groupName(ids.gid)}`;
      if (verbose) {
        if (result.before.uid !== result.after.uid || result.before.gid !== result.after.gid) {
          out.push(
            command === 'chgrp'
              ? `changed group of ${q(shown)} from ${name(result.before)} to ${name(result.after)}`
              : `changed ownership of ${q(shown)} from ${name(result.before)} to ${name(result.after)}`
          );
        } else
          out.push(
            command === 'chgrp'
              ? `group of ${q(shown)} retained as ${name(result.after)}`
              : `ownership of ${q(shown)} retained as ${name(result.after)}`
          );
      }
      if (recursive && result.node.type === 'dir') {
        const listing = host.readdir(target, { user });
        if (listing.ok)
          for (const entry of listing.entries)
            apply(`${shown.replace(/\/+$/, '')}/${entry.name}`, entry.path);
      }
    };
    for (const target of positionals) apply(target, target);
    this._refreshFilesPanel();
    if (errors.length) return fail([...out, ...errors].join('\n'));
    return ok(out.join('\n'));
  },

  _cmd_umask(args) {
    const session = this.host.session;
    if (!args.length) return ok(octalMode(session.umask));
    if (args[0] === '-S') {
      const allowed = ~session.umask & 0o777;
      const part = (shift) =>
        ['r', 'w', 'x'].filter((perm, index) => allowed & (1 << (shift + 2 - index))).join('');
      return ok(`u=${part(6)},g=${part(3)},o=${part(0)}`);
    }
    if (!/^[0-7]{1,4}$/.test(args[0]))
      return fail(`bash: umask: ${args[0]}: octal number out of range`);
    session.umask = Number.parseInt(args[0], 8) & 0o777;
    return ok('');
  },

  // ── accounts (root only) ─────────────────────────────────────────────────

  _requireRoot(command) {
    if (this._user() === 'root') return null;
    return fail(
      `${command}: Permission denied.\n${command}: cannot lock /etc/passwd; try again later.`,
      1
    );
  },

  _cmd_useradd(args) {
    const denied = this._requireRoot('useradd');
    if (denied) return denied;
    const { values, flags, positionals } = parseArgs(args, { valueShort: 'ugGcdsep' });
    const name = positionals[0];
    if (!name)
      return fail(
        'Usage: useradd [options] LOGIN\n       useradd -D\n       useradd -D [options]',
        2
      );
    if (this.host.users.has(name)) return fail(`useradd: user '${name}' already exists`, 9);
    for (const group of String(values.get('G') || '')
      .split(',')
      .filter(Boolean)) {
      if (!this.host.groups.has(group)) return fail(`useradd: group '${group}' does not exist`, 6);
    }
    if (
      values.has('g') &&
      !this.host.groups.has(values.get('g')) &&
      !/^\d+$/.test(values.get('g'))
    ) {
      return fail(`useradd: group '${values.get('g')}' does not exist`, 6);
    }
    this.host.addUser({
      name,
      uid: values.has('u') ? Number(values.get('u')) : undefined,
      group: values.get('g'),
      groups: String(values.get('G') || '')
        .split(',')
        .filter(Boolean),
      comment: values.get('c') ?? '',
      home: values.get('d'),
      shell: values.get('s'),
      createHome: !flags.has('M'),
    });
    return ok('');
  },

  _cmd_usermod(args) {
    const denied = this._requireRoot('usermod');
    if (denied) return denied;
    const { values, flags, positionals } = parseArgs(args, { valueShort: 'ugGcdsl' });
    const name = positionals[0];
    const host = this.host;
    if (!name) return fail('Usage: usermod [options] LOGIN', 2);
    const user = host.users.get(name);
    if (!user) return fail(`usermod: user '${name}' does not exist`, 6);
    if (values.has('G')) {
      const wanted = String(values.get('G')).split(',').filter(Boolean);
      for (const group of wanted)
        if (!host.groups.has(group)) return fail(`usermod: group '${group}' does not exist`, 6);
      if (!flags.has('a')) for (const group of host.groups.values()) group.members.delete(name);
      for (const group of wanted) host.groups.get(group).members.add(name);
    }
    if (values.has('g')) {
      const group = host.groups.get(values.get('g'));
      if (!group) return fail(`usermod: group '${values.get('g')}' does not exist`, 6);
      user.gid = group.gid;
    }
    if (values.has('s')) user.shell = values.get('s');
    if (values.has('c')) user.gecos = values.get('c');
    if (values.has('d')) user.home = values.get('d');
    if (values.has('u')) user.uid = Number(values.get('u'));
    const shadow = host.shadow.get(name);
    if (flags.has('L') && shadow && !shadow.hash.startsWith('!')) shadow.hash = `!${shadow.hash}`;
    if (flags.has('U') && shadow) shadow.hash = shadow.hash.replace(/^!+/, '') || '!!';
    return ok('');
  },

  _cmd_userdel(args) {
    const denied = this._requireRoot('userdel');
    if (denied) return denied;
    const { flags, positionals } = parseArgs(args);
    const name = positionals[0];
    const host = this.host;
    if (!host.users.has(name)) return fail(`userdel: user '${name}' does not exist`, 6);
    const user = host.users.get(name);
    host.users.delete(name);
    host.shadow.delete(name);
    for (const group of host.groups.values()) group.members.delete(name);
    const own = host.groups.get(name);
    if (own && own.gid === user.gid) host.groups.delete(name);
    if (flags.has('r')) host.removeTree(user.home, { user: 'root' });
    return ok('');
  },

  _cmd_groupadd(args) {
    const denied = this._requireRoot('groupadd');
    if (denied) return denied;
    const { values, positionals } = parseArgs(args, { valueShort: 'g' });
    const name = positionals[0];
    if (!name) return fail('Usage: groupadd [options] GROUP', 2);
    if (this.host.groups.has(name)) return fail(`groupadd: group '${name}' already exists`, 9);
    this.host.addGroup({ name, gid: values.has('g') ? Number(values.get('g')) : undefined });
    return ok('');
  },

  _cmd_groupdel(args) {
    const denied = this._requireRoot('groupdel');
    if (denied) return denied;
    const name = args.find((arg) => !arg.startsWith('-'));
    if (!this.host.groups.has(name)) return fail(`groupdel: group '${name}' does not exist`, 6);
    this.host.groups.delete(name);
    return ok('');
  },

  _cmd_passwd(args, stdin) {
    const host = this.host;
    const { flags, longs, positionals } = parseArgs(args);
    const target = positionals[0] ?? this._user();
    const root = this._user() === 'root';
    if (positionals[0] && !root && positionals[0] !== this._user()) {
      return fail('passwd: Only root can specify a user name.');
    }
    if (!host.users.has(target)) return fail(`passwd: Unknown user name '${target}'.`);
    const shadow = host.shadow.get(target) || {
      hash: '!!',
      lastChange: 0,
      min: 0,
      max: 99999,
      warn: 7,
    };
    if (flags.has('S')) {
      const state = shadow.hash.startsWith('!') ? 'LK' : shadow.hash === '' ? 'NP' : 'PS';
      const label =
        state === 'LK'
          ? 'Password locked.'
          : state === 'NP'
            ? 'Empty password.'
            : 'Password set, SHA512 crypt.';
      return ok(
        `${target} ${state} ${new Date(shadow.lastChange * 86400000).toISOString().slice(0, 10)} ${shadow.min} ${shadow.max} ${shadow.warn} -1 (${label})`
      );
    }
    if (flags.has('l') || flags.has('u')) {
      if (!root) return fail('passwd: Only root can do that.');
      if (flags.has('l')) {
        if (!shadow.hash.startsWith('!')) shadow.hash = `!!${shadow.hash}`;
        return ok(`Locking password for user ${target}.\npasswd: Success`);
      }
      shadow.hash = shadow.hash.replace(/^!+/, '');
      return ok(`Unlocking password for user ${target}.\npasswd: Success`);
    }
    if (longs.has('stdin')) {
      if (!root) return fail('passwd: Only root can do that.');
      const password = String(stdin ?? '').split('\n')[0];
      host.shadow.set(target, {
        ...shadow,
        hash: `$6$${fakeSha256(`salt:${target}`).slice(0, 16)}$${fakeSha256(`${target}:${password}`)}`,
        lastChange: Math.floor(host.now() / 86400000),
      });
      return ok(
        `Changing password for user ${target}.\npasswd: all authentication tokens updated successfully.`
      );
    }
    return fail(
      `Changing password for user ${target}.\nNew password: \npasswd: Authentication token manipulation error\n(simulator: the terminal cannot answer password prompts — use: echo 'NewPassw0rd' | sudo passwd --stdin ${target})`
    );
  },

  // ── sudo / su / login shells ─────────────────────────────────────────────

  _cmd_sudo(args, stdin) {
    const host = this.host;
    const session = host.session;
    let index = 0;
    let target = 'root';
    let login = false;
    let shell = false;
    const caller = this._user();
    while (index < args.length && args[index].startsWith('-')) {
      const arg = args[index];
      if (arg === '--') {
        index += 1;
        break;
      }
      if (arg === '-u' || arg === '--user') target = args[++index] ?? 'root';
      else if (arg.startsWith('--user=')) target = arg.slice(7);
      else if (arg === '-i' || arg === '--login') login = true;
      else if (arg === '-s' || arg === '--shell') shell = true;
      else if (arg === '-l' || arg === '--list') {
        return ok(
          [
            `Matching Defaults entries for ${caller} on ${host.hostname.split('.')[0]}:`,
            '    !visiblepw, always_set_home, match_group_by_gid, always_query_group_plugin, env_reset, env_keep="COLORS DISPLAY HOSTNAME HISTSIZE KDEDIR LS_COLORS", env_keep+="MAIL PS1 PS2 QTDIR USERNAME LANG LC_ADDRESS LC_CTYPE", secure_path=/sbin\\:/bin\\:/usr/sbin\\:/usr/bin',
            '',
            `User ${caller} may run the following commands on ${host.hostname.split('.')[0]}:`,
            '    (ALL) ALL',
            ...(caller === 'student' ? ['    (ALL) NOPASSWD: ALL'] : []),
          ].join('\n')
        );
      } else if (arg === '-v' || arg === '-k' || arg === '-K') return ok('');
      else if (arg === '-E' || arg === '-H' || arg === '-n' || arg === '-S') {
        /* accepted */
      } else if (/^-u\S+$/.test(arg)) target = arg.slice(2);
      else
        return fail(
          `sudo: invalid option -- '${arg.replace(/^-+/, '').charAt(0)}'\nusage: sudo -h | -K | -k | -V\nusage: sudo -v [-ABknS] [-g group] [-h host] [-p prompt] [-u user]\nusage: sudo -l [-ABknS] [-g group] [-h host] [-p prompt] [-U user] [-u user] [command]\nusage: sudo [-ABbEHknPS] [-r role] [-t type] [-C num] [-D directory] [-g group] [-h host] [-p prompt] [-R directory] [-T timeout] [-u user] [VAR=value] [-i|-s] [<command>]\nusage: sudo -e [-ABknS] [-r role] [-t type] [-C num] [-D directory] [-g group] [-h host] [-p prompt] [-R directory] [-T timeout] [-u user] file ...`
        );
      index += 1;
    }
    // sudoers: student has NOPASSWD (lab); other wheel members would need a password prompt.
    const identity = host.identity(caller);
    if (caller !== 'root') {
      if (!identity?.gids.has(10))
        return fail(`${caller} is not in the sudoers file.  This incident will be reported.`);
      if (caller !== 'student') {
        return fail(
          'sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper\nsudo: a password is required'
        );
      }
    }
    if (!host.users.has(target))
      return fail(
        `sudo: unknown user ${target}\nsudo: error initializing audit plugin sudoers_audit`
      );
    const command = args.slice(index);
    host._journalAppend({
      ident: 'sudo',
      pid: null,
      message: `${caller.padStart(8)} : TTY=pts/0 ; PWD=${session.cwd} ; USER=${target} ; COMMAND=${command.length ? this._commandPath(command[0]) + (command.length > 1 ? ` ${command.slice(1).join(' ')}` : '') : '/bin/bash'}`,
      priority: 5,
      facility: 'authpriv',
    });
    if (!command.length) {
      if (login || shell) {
        host.pushLogin(target, { cwd: login ? host.homeOf(target) : session.cwd });
        return ok('');
      }
      return fail(
        'usage: sudo -h | -K | -k | -V\nusage: sudo -v [-ABknS] [-g group] [-h host] [-p prompt] [-u user]\nusage: sudo -l [-ABknS] [-g group] [-h host] [-p prompt] [-U user] [-u user] [command]\nusage: sudo [-ABbEHknPS] [-r role] [-t type] [-C num] [-D directory] [-g group] [-h host] [-p prompt] [-R directory] [-T timeout] [-u user] [VAR=value] [-i|-s] [<command>]\nusage: sudo -e [-ABknS] [-r role] [-t type] [-C num] [-D directory] [-g group] [-h host] [-p prompt] [-R directory] [-T timeout] [-u user] file ...'
      );
    }
    const name = command[0];
    // `sudo su -` / `sudo -i` style login shells.
    if (name === 'su' || name === 'bash' || name === 'sh') {
      if (
        name === 'su' ||
        command.length === 1 ||
        command[1] === '-' ||
        command[1] === '-l' ||
        command[1] === '--login'
      ) {
        const suTarget =
          name === 'su' ? command.slice(1).find((arg) => !arg.startsWith('-')) || 'root' : target;
        if (name !== 'su' || !command.slice(1).some((arg) => arg === '-c')) {
          if (!host.users.has(suTarget))
            return fail(
              `su: user ${suTarget} does not exist or the user entry does not contain all the required fields`
            );
          const loginShell =
            name === 'su'
              ? command.slice(1).some((arg) => arg === '-' || arg === '-l' || arg === '--login')
              : command[1] === '-l' || command[1] === '--login';
          host.pushLogin(suTarget, {
            cwd: loginShell || login ? host.homeOf(suTarget) : session.cwd,
          });
          return ok('');
        }
      }
    }
    if (name === 'oc' || name === 'kubectl') {
      // sudo resets HOME/KUBECONFIG (env_reset, always_set_home): root has no kubeconfig.
      return fail(
        "error: Missing or incomplete configuration info.  Please point to an existing, complete config file:\n\n\n  1. Via the command-line flag --kubeconfig\n  2. Via the KUBECONFIG environment variable\n  3. In your home directory as ~/.kube/config\n\nTo view or setup config directly use the 'config' command."
      );
    }
    if (name === 'cd') return fail('sudo: cd: command not found');
    if (!this[`_cmd_${name.toLowerCase()}`] && !this.isShellLead(name))
      return fail(`sudo: ${name}: command not found`);
    if (!host.commandAvailable(name)) return fail(`sudo: ${name}: command not found`);
    const previous = this._euser;
    this._euser = target;
    this._sudoDepth += 1;
    try {
      return this.runTokens(command, stdin);
    } finally {
      this._euser = previous;
      this._sudoDepth -= 1;
    }
  },

  /** `/usr/bin/systemctl` style absolute command path for logs. */
  _commandPath(name) {
    if (String(name).includes('/')) return name;
    for (const dir of ['/usr/bin', '/usr/sbin']) {
      if (this.host.nodes.has(`${dir}/${name}`)) return `${dir}/${name}`;
    }
    return `/usr/bin/${name}`;
  },

  _cmd_su(args) {
    const host = this.host;
    const loginShell = args.some((arg) => arg === '-' || arg === '-l' || arg === '--login');
    const commandIndex = args.indexOf('-c');
    const target =
      args.find((arg, index) => !arg.startsWith('-') && index !== commandIndex + 1) || 'root';
    if (!host.users.has(target))
      return fail(
        `su: user ${target} does not exist or the user entry does not contain all the required fields`
      );
    if (this._user() !== 'root') {
      return fail(
        'Password: \nsu: Authentication failure\n(simulator: the terminal cannot answer password prompts — student has passwordless sudo: use sudo -i or sudo su -)'
      );
    }
    if (commandIndex >= 0) {
      const previous = this._euser;
      this._euser = target;
      try {
        return this._runScriptText(String(args[commandIndex + 1] ?? ''), { name: 'su' });
      } finally {
        this._euser = previous;
      }
    }
    host.pushLogin(target, { cwd: loginShell ? host.homeOf(target) : host.session.cwd });
    return ok('');
  },

  _cmd_logout() {
    if (this.host.popLogin()) return ok('logout');
    return fail("bash: logout: not login shell: use `exit'");
  },

  // ── SELinux ──────────────────────────────────────────────────────────────

  _cmd_getenforce() {
    const mode = this.host.selinux.mode;
    return ok(mode.charAt(0).toUpperCase() + mode.slice(1));
  },

  _cmd_setenforce(args) {
    const value = String(args[0] ?? '');
    if (!/^(0|1|enforcing|permissive)$/i.test(value))
      return fail('usage:  setenforce [ Enforcing | Permissive | 1 | 0 ]');
    if (this.host.selinux.mode === 'disabled') return fail('setenforce: SELinux is disabled');
    if (this._user() !== 'root') return fail('setenforce:  setenforce() failed');
    this.host.setEnforce(/^(1|enforcing)$/i.test(value) ? 'enforcing' : 'permissive');
    return ok('');
  },

  _cmd_sestatus() {
    const host = this.host;
    if (host.selinux.mode === 'disabled') return ok('SELinux status:                 disabled');
    return ok(
      [
        'SELinux status:                 enabled',
        'SELinuxfs mount:                /sys/fs/selinux',
        'SELinux root directory:         /etc/selinux',
        'Loaded policy name:             targeted',
        `Current mode:                   ${host.selinux.mode}`,
        `Mode from config file:          ${host.selinuxConfigMode()}`,
        'Policy MLS status:              enabled',
        'Policy deny_unknown status:     allowed',
        'Memory protection checking:     actual (secure)',
        'Max kernel policy version:      33',
      ].join('\n')
    );
  },

  _cmd_restorecon(args) {
    const { flags, positionals } = parseArgs(args);
    if (!positionals.length)
      return fail(
        'usage:  restorecon [-iIDFmnprRv0x] [-e excludedir] pathname...\nusage:  restorecon [-iIDFmnprRv0x] [-e excludedir] -f filename',
        255
      );
    const out = [];
    const errors = [];
    const user = this._user();
    for (const target of positionals) {
      const found = this.host.stat(target, { user, follow: false });
      if (!found.ok) {
        errors.push(`restorecon: lstat(${target}) failed: ${errnoText(found.error)}`);
        continue;
      }
      const preview = this.host.restorecon(target, {
        recursive: flags.has('R') || flags.has('r'),
        user: 'root',
      });
      if (preview.error) continue;
      const identity = this.host.identity(user);
      const denied = preview.changes.filter((change) => {
        const node = this.host._lookup(change.path);
        return identity.uid !== 0 && node && node.uid !== identity.uid;
      });
      if (denied.length) {
        // Undo: a non-owner may not relabel (EPERM from setxattr security.selinux).
        for (const change of preview.changes) {
          const node = this.host._lookup(change.path);
          if (node && identity.uid !== 0 && node.uid !== identity.uid) {
            const meta = this.host._metaNode(change.path, node);
            meta.context = change.from;
          }
        }
        for (const change of denied)
          errors.push(
            `restorecon: Could not set context for ${change.path}:  Operation not permitted`
          );
      }
      for (const change of preview.changes) {
        if (denied.includes(change)) continue;
        if (flags.has('v'))
          out.push(`Relabeled ${change.path} from ${change.from} to ${change.to}`);
      }
    }
    if (errors.length) return fail([...out, ...errors].join('\n'), 255);
    return ok(out.join('\n'));
  },

  _cmd_chcon(args) {
    const { flags, values, positionals } = parseArgs(args, { valueShort: 'turl' });
    const type = values.get('t');
    let context = null;
    let files = positionals;
    if (!type && !values.has('u') && !values.has('r')) {
      context = positionals[0];
      files = positionals.slice(1);
    }
    if (!files.length)
      return fail("chcon: missing operand\nTry 'chcon --help' for more information.");
    for (const file of files) {
      const changed = this.host.chcon(file, {
        type,
        context,
        recursive: flags.has('R'),
        user: this._user(),
      });
      if (changed.error === 'EPERM')
        return fail(
          `chcon: failed to change context of ${q(file)} to ${cq(context || type)}: Operation not permitted`
        );
      if (changed.error)
        return fail(`chcon: cannot access ${q(file)}: ${errnoText(changed.error)}`);
    }
    return ok('');
  },

  _cmd_semanage(args) {
    const host = this.host;
    if (this._user() !== 'root')
      return fail('ValueError: SELinux policy is not managed or store cannot be accessed.');
    const [object, ...rest] = args;
    const { flags, values, positionals } = parseArgs(rest, { valueShort: 'tpsrf' });
    if (object === 'port') {
      if (flags.has('l')) {
        const rows = [['SELinux Port Type', 'Proto', 'Port Number'], []];
        const lines = ['SELinux Port Type              Proto    Port Number', ''];
        void rows;
        const types = Object.keys(host.selinux.ports).sort();
        for (const type of types) {
          for (const proto of Object.keys(host.selinux.ports[type]).sort()) {
            const ports = host.selinux.ports[type][proto];
            lines.push(`${type.padEnd(30)} ${proto.padEnd(8)} ${compressPorts(ports)}`);
          }
        }
        return ok(lines.join('\n'));
      }
      if (flags.has('a')) {
        const type = values.get('t');
        const proto = values.get('p');
        const port = positionals[0];
        if (!type || !proto || !port)
          return fail(
            'usage: semanage port [-h] [-n] [-N] [-S STORE] [ --add -t TYPE -p PROTOCOL -r RANGE port_name | port_range ]'
          );
        const added = host.addPortLabel(type, proto, Number(port));
        if (added.error) return fail(added.error);
        return ok('');
      }
      if (flags.has('d')) {
        const removed = host.deletePortLabel(values.get('p'), Number(positionals[0]));
        if (removed.error) return fail(removed.error);
        return ok('');
      }
    }
    if (object === 'fcontext') {
      if (flags.has('l')) {
        const lines = [
          'SELinux fcontext                                   type               Context',
          '',
        ];
        for (const rule of host.selinux.fcontext)
          lines.push(
            `${rule.pattern.padEnd(50)} all files          system_u:object_r:${rule.type}:s0`
          );
        lines.push(
          `${'/var/www(/.*)?'.padEnd(50)} all files          system_u:object_r:httpd_sys_content_t:s0`,
          `${'/var/www/cgi-bin(/.*)?'.padEnd(50)} all files          system_u:object_r:httpd_sys_script_exec_t:s0`,
          `${'/etc/httpd(/.*)?'.padEnd(50)} all files          system_u:object_r:httpd_config_t:s0`,
          `${'/home/[^/]+'.padEnd(50)} directory          unconfined_u:object_r:user_home_dir_t:s0`,
          `${'/tmp'.padEnd(50)} directory          system_u:object_r:tmp_t:s0`
        );
        return ok(lines.join('\n'));
      }
      if (flags.has('a')) {
        const type = values.get('t');
        const pattern = positionals[0];
        if (!type || !pattern)
          return fail(
            'usage: semanage fcontext [-h] [-n] [-N] [-S STORE] [ --add ( -t TYPE -f FTYPE -r RANGE -s SEUSER | -e EQUAL ) FILE_SPEC ]'
          );
        const added = host.addFcontext(type, pattern);
        if (added.error) return fail(added.error);
        return ok('');
      }
    }
    if (object === 'boolean' && flags.has('l')) {
      return ok(
        'SELinux boolean                State  Default Description\n\nhttpd_can_network_connect      (off  ,  off)  Allow httpd to can network connect\nhttpd_enable_homedirs          (off  ,  off)  Allow httpd to enable homedirs\nhttpd_read_user_content        (off  ,  off)  Allow httpd to read user content'
      );
    }
    return fail(
      'usage: semanage [-h]\n                \n                {import,export,login,user,port,ibpkey,ibendport,interface,module,node,fcontext,boolean,permissive,dontaudit}\n                ...\nsemanage: error: the following arguments are required: subcommand',
      2
    );
  },

  // ── system information ───────────────────────────────────────────────────

  _cmd_hostname(args) {
    const host = this.host;
    const { flags, positionals } = parseArgs(args);
    if (flags.has('I')) return ok(`${WORKSTATION_IP} `);
    if (flags.has('i')) return ok(WORKSTATION_IP);
    if (flags.has('s')) return ok(host.hostname.split('.')[0]);
    if (flags.has('d')) return ok(host.hostname.split('.').slice(1).join('.'));
    if (positionals.length) {
      if (this._user() !== 'root')
        return fail('hostname: you must be root to change the host name');
      host.hostname = positionals[0];
      return ok('');
    }
    return ok(host.hostname);
  },

  _cmd_hostnamectl(args) {
    const host = this.host;
    const sub = args.find((arg) => !arg.startsWith('-')) || 'status';
    if (sub === 'set-hostname') {
      const name = args[args.indexOf('set-hostname') + 1];
      if (!name) return fail('Too few arguments.');
      if (this._user() !== 'root')
        return fail('Could not set static hostname: Interactive authentication required.');
      host.hostname = name;
      const node = host._lookup('/etc/hostname');
      if (node) host._acceptGenerated('hostname', '/etc/hostname', `${name}\n`);
      return ok('');
    }
    if (sub === 'hostname') return ok(host.hostname);
    return ok(
      [
        ` Static hostname: ${host.hostname}`,
        '       Icon name: computer-vm',
        '         Chassis: vm 🖴',
        '      Machine ID: 2d0a8c1f7e9b4b5c9a3f6e1d2c4b8a07',
        `         Boot ID: ${fakeSha256(`boot-${host.bootTime}`).slice(0, 32)}`,
        '  Virtualization: kvm',
        `Operating System: Red Hat Enterprise Linux ${RHEL_VERSION} (Plow)`,
        '     CPE OS Name: cpe:/o:redhat:enterprise_linux:9::baseos',
        `          Kernel: Linux ${KERNEL_RELEASE}`,
        '    Architecture: x86-64',
        ' Hardware Vendor: Red Hat',
        '  Hardware Model: KVM',
        'Firmware Version: 1.16.3-2.el9',
      ].join('\n')
    );
  },

  _cmd_timedatectl(args) {
    const host = this.host;
    const sub = args.find((arg) => !arg.startsWith('-')) || 'status';
    const chronyd = host.serviceState('chronyd');
    if (sub === 'set-ntp') {
      if (this._user() !== 'root')
        return fail('Failed to set ntp: Interactive authentication required.');
      const enable = /^(1|yes|true|on)$/i.test(String(args[args.indexOf('set-ntp') + 1]));
      if (enable) host.enableUnit('chronyd', { now: true });
      else host.disableUnit('chronyd', { now: true });
      return ok('');
    }
    if (sub === 'list-timezones')
      return ok(
        [
          'Africa/Abidjan',
          'America/New_York',
          'Asia/Shanghai',
          'Europe/Berlin',
          'Europe/London',
          'UTC',
        ].join('\n')
      );
    if (sub === 'set-timezone') {
      if (this._user() !== 'root')
        return fail('Failed to set time zone: Interactive authentication required.');
      return ok('');
    }
    const now = host.now();
    const synced = chronyd.active && now - (host.getUnit('chronyd')?.activeEnter ?? now) >= 0;
    return ok(
      [
        `               Local time: ${formatSystemdTime(now)}`,
        `           Universal time: ${formatSystemdTime(now)}`,
        `                 RTC time: ${formatSystemdTime(now - 1000).replace(/ UTC$/, '')}`,
        '                Time zone: UTC (UTC, +0000)',
        `System clock synchronized: ${synced ? 'yes' : 'no'}`,
        `              NTP service: ${chronyd.active ? 'active' : 'inactive'}`,
        '          RTC in local TZ: no',
      ].join('\n')
    );
  },

  _cmd_chronyc(args) {
    const host = this.host;
    if (!host.serviceState('chronyd').active) return fail('506 Cannot talk to daemon');
    const sub = args.find((arg) => !arg.startsWith('-')) || 'tracking';
    if (sub === 'sources') {
      return ok(
        [
          'MS Name/IP address         Stratum Poll Reach LastRx Last sample               ',
          '===============================================================================',
          '^* classroom.example.com         8   6   377    31   +128us[ +170us] +/-   44ms',
        ].join('\n')
      );
    }
    return ok(
      [
        'Reference ID    : AC19FEFE (classroom.example.com)',
        'Stratum         : 9',
        `Ref time (UTC)  : ${formatDate(host.now() - 31000).replace(/ UTC (\d+)$/, ' $1')}`,
        'System time     : 0.000000143 seconds fast of NTP time',
        'Last offset     : +0.000042170 seconds',
        'RMS offset      : 0.000057813 seconds',
        'Frequency       : 3.214 ppm slow',
        'Residual freq   : +0.002 ppm',
        'Skew            : 0.071 ppm',
        'Root delay      : 0.087531507 seconds',
        'Root dispersion : 0.001237214 seconds',
        'Update interval : 64.3 seconds',
        'Leap status     : Normal',
      ].join('\n')
    );
  },

  _cmd_uname(args) {
    const host = this.host;
    const { flags } = parseArgs(args);
    const parts = {
      s: 'Linux',
      n: host.hostname,
      r: KERNEL_RELEASE,
      v: KERNEL_VERSION,
      m: 'x86_64',
      p: 'x86_64',
      i: 'x86_64',
      o: 'GNU/Linux',
    };
    if (flags.has('a')) return ok(Object.values(parts).join(' '));
    const order = ['s', 'n', 'r', 'v', 'm', 'p', 'i', 'o'].filter((key) => flags.has(key));
    return ok((order.length ? order : ['s']).map((key) => parts[key]).join(' '));
  },

  _cmd_date(args) {
    const host = this.host;
    const now = host.now();
    const format = args.find((arg) => arg.startsWith('+'));
    if (args.includes('-I') || args.includes('--iso-8601'))
      return ok(new Date(now).toISOString().slice(0, 10));
    if (args.includes('-R') || args.includes('--rfc-email'))
      return ok(new Date(now).toUTCString().replace('GMT', '+0000'));
    if (args.some((arg) => arg === '-s' || arg.startsWith('--set'))) {
      if (this._user() !== 'root') return fail('date: cannot set date: Operation not permitted');
      return ok(formatDate(now));
    }
    if (!format) return ok(formatDate(now));
    const d = new Date(now);
    const p2 = (value) => String(value).padStart(2, '0');
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];
    const map = {
      Y: d.getUTCFullYear(),
      y: p2(d.getUTCFullYear() % 100),
      m: p2(d.getUTCMonth() + 1),
      d: p2(d.getUTCDate()),
      e: String(d.getUTCDate()).padStart(2, ' '),
      H: p2(d.getUTCHours()),
      I: p2(d.getUTCHours() % 12 || 12),
      M: p2(d.getUTCMinutes()),
      S: p2(d.getUTCSeconds()),
      p: d.getUTCHours() < 12 ? 'AM' : 'PM',
      F: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`,
      T: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`,
      R: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`,
      D: `${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}/${p2(d.getUTCFullYear() % 100)}`,
      s: Math.floor(now / 1000),
      Z: 'UTC',
      z: '+0000',
      a: days[d.getUTCDay()].slice(0, 3),
      A: days[d.getUTCDay()],
      b: months[d.getUTCMonth()].slice(0, 3),
      h: months[d.getUTCMonth()].slice(0, 3),
      B: months[d.getUTCMonth()],
      j: String(Math.floor((now - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1).padStart(
        3,
        '0'
      ),
      u: d.getUTCDay() || 7,
      w: d.getUTCDay(),
      n: '\n',
      t: '\t',
      '%': '%',
    };
    return ok(
      format
        .slice(1)
        .replace(/%([a-zA-Z%])/g, (match, code) =>
          map[code] !== undefined ? String(map[code]) : match
        )
    );
  },

  _cmd_uptime(args) {
    const host = this.host;
    const now = host.now();
    const seconds = Math.floor((now - host.bootTime) / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (args.includes('-p') || args.includes('--pretty')) {
      const parts = [];
      if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
      parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
      return ok(`up ${parts.join(', ')}`);
    }
    if (args.includes('-s') || args.includes('--since')) {
      return ok(new Date(host.bootTime).toISOString().replace('T', ' ').slice(0, 19));
    }
    const load = host
      .loadAverage()
      .map((value) => value.toFixed(2))
      .join(', ');
    const up = hours
      ? `${String(hours).padStart(2)}:${String(minutes).padStart(2, '0')}`
      : `${minutes} min`;
    return ok(
      ` ${new Date(now).toISOString().slice(11, 19)} up ${up},  1 user,  load average: ${load}`
    );
  },

  _cmd_free(args) {
    const mem = this.host.memory();
    const { flags, longs } = parseArgs(args);
    const human = flags.has('h') || longs.has('human');
    const unit = flags.has('g') ? 1024 * 1024 : flags.has('m') ? 1024 : 1;
    const fmt = (kib) => {
      if (human) {
        if (kib === 0) return '0B';
        const units = ['Ki', 'Mi', 'Gi', 'Ti'];
        let value = kib;
        let index = 0;
        while (value >= 1024 && index < units.length - 1) {
          value /= 1024;
          index += 1;
        }
        return `${value >= 10 ? Math.round(value) : value.toFixed(1)}${units[index]}`;
      }
      return String(Math.round(kib / unit));
    };
    const header =
      '               total        used        free      shared  buff/cache   available';
    const row = (label, values) =>
      `${label.padEnd(8)}${values.map((value) => fmt(value).padStart(12)).join('')}`;
    const lines = [
      header,
      row('Mem:', [mem.total, mem.used, mem.free, mem.shared, mem.cache, mem.available]),
      row('Swap:', [0, 0, 0]),
    ];
    if (flags.has('t')) lines.push(row('Total:', [mem.total, mem.used, mem.free]));
    return ok(lines.join('\n'));
  },

  _cmd_history(args) {
    const entries = [...(this.bar?.history || [])].reverse();
    const count = Number(args.find((arg) => /^\d+$/.test(arg))) || entries.length;
    const start = Math.max(0, entries.length - count);
    if (args.includes('-c')) {
      if (this.bar?.history) this.bar.history.length = 0;
      return ok('');
    }
    return ok(
      entries
        .slice(start)
        .map((line, index) => `${String(start + index + 1).padStart(5)}  ${line}`)
        .join('\n')
    );
  },

  _cmd_type(args) {
    const out = [];
    let status = 0;
    const builtins = new Set([
      'cd',
      'echo',
      'export',
      'source',
      '.',
      'pwd',
      'type',
      'umask',
      'unset',
      'history',
      'kill',
      'true',
      'false',
      'exit',
      'logout',
      'alias',
      'printf',
      'read',
      'test',
      '[',
    ]);
    for (const name of args.filter((arg) => !arg.startsWith('-'))) {
      if (SHELL_ALIASES[name]) out.push(`${name} is aliased to \`${SHELL_ALIASES[name]}'`);
      else if (builtins.has(name)) out.push(`${name} is a shell builtin`);
      else {
        const found = this._which(name);
        if (found) out.push(`${name} is ${found}`);
        else {
          out.push(`bash: type: ${name}: not found`);
          status = 1;
        }
      }
    }
    return status ? fail(out.join('\n')) : ok(out.join('\n'));
  },

  /** Absolute path of a command on $PATH (null when missing). */
  _which(name) {
    const host = this.host;
    if (String(name).includes('/')) {
      const found = host.stat(name, { user: this._user() });
      return found.ok && found.node.type === 'file' ? name : null;
    }
    const pathValue = this.exportedEnvironment().PATH;
    for (const dir of pathValue.split(':').filter(Boolean)) {
      const candidate = normalizePath(`${dir}/${name}`);
      const found = host.stat(candidate, { user: 'root' });
      if (found.ok && found.node.type === 'file' && found.node.mode & 0o111) return candidate;
    }
    return null;
  },

  _cmd_which(args) {
    if (!args.length)
      return fail(
        'Usage: /usr/bin/which [options] [--] COMMAND [...]\nWrite the full path of COMMAND(s) to standard output.'
      );
    const out = [];
    let status = 0;
    const pathValue = this.exportedEnvironment().PATH;
    const home = this.host.homeOf(this.host.session.user);
    for (const name of args.filter((arg) => !arg.startsWith('-'))) {
      if (SHELL_ALIASES[name]) {
        out.push(`alias ${name}='${SHELL_ALIASES[name]}'`);
        const target = SHELL_ALIASES[name].split(' ')[0];
        const found = this._which(target);
        if (found) out.push(`\t${found}`);
        continue;
      }
      const found = this._which(name);
      if (found) out.push(found.startsWith(`${home}/`) ? `~${found.slice(home.length)}` : found);
      else {
        out.push(`/usr/bin/which: no ${name} in (${pathValue})`);
        status = 1;
      }
    }
    return status ? { error: true, message: out.join('\n'), exitCode: 1 } : ok(out.join('\n'));
  },

  _cmd_man(args) {
    const name = args.find((arg) => !arg.startsWith('-') && !/^\d$/.test(arg));
    if (!name) return fail("What manual page do you want?\nFor example, try 'man man'.", 1);
    const page = MAN_PAGES[name];
    if (!page) return fail(`No manual entry for ${name}`, 16);
    const [section, summary, synopsis] = page;
    const title = `${name.toUpperCase()}(${section})`;
    const header = `${title}${' '.repeat(Math.max(1, 30 - title.length))}${section === 8 ? 'System Administration' : 'User Commands'}${' '.repeat(10)}${title}`;
    return ok(
      [
        header,
        '',
        'NAME',
        `       ${name} - ${summary}`,
        '',
        'SYNOPSIS',
        ...synopsis.map((line) => `       ${line}`),
        '',
        'DESCRIPTION',
        `       (simulator) The full manual is available on a real RHEL 9 system: man ${name}.`,
      ].join('\n')
    );
  },

  _cmd_alias(args) {
    if (!args.length)
      return ok(
        Object.entries(SHELL_ALIASES)
          .map(([name, value]) => `alias ${name}='${value}'`)
          .join('\n')
      );
    const out = [];
    for (const arg of args) {
      const eq = arg.indexOf('=');
      if (eq < 0) {
        if (SHELL_ALIASES[arg]) out.push(`alias ${arg}='${SHELL_ALIASES[arg]}'`);
        else return fail(`bash: alias: ${arg}: not found`);
      } else this.host.session.aliases.set(arg.slice(0, eq), arg.slice(eq + 1));
    }
    return ok(out.join('\n'));
  },

  _cmd_ll(args, stdin) {
    return this._cmd_ls(['-l', ...args], stdin);
  },

  _cmd_w() {
    const host = this.host;
    const now = host.now();
    const load = host
      .loadAverage()
      .map((value) => value.toFixed(2))
      .join(', ');
    const seconds = Math.floor((now - host.bootTime) / 1000);
    return ok(
      [
        ` ${new Date(now).toISOString().slice(11, 19)} up ${String(Math.floor(seconds / 3600)).padStart(2)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')},  1 user,  load average: ${load}`,
        'USER     TTY        LOGIN@   IDLE   JCPU   PCPU WHAT',
        `student  pts/0     ${formatClock(host.bootTime + 312000)}    0.00s  0.04s  0.00s w`,
      ].join('\n')
    );
  },

  _cmd_who() {
    const host = this.host;
    const login = new Date(host.bootTime + 312000).toISOString();
    return ok(
      `student  pts/0        ${login.slice(0, 10)} ${login.slice(11, 16)} (172.25.254.254)`
    );
  },

  // ── processes ────────────────────────────────────────────────────────────

  _psRows() {
    const host = this.host;
    const self = {
      pid: host.nextPid + 1 + (host.execLog.length % 50),
      ppid: host.shellPid || 2297,
      user: host.session.user,
      comm: 'ps',
      args: 'ps',
      start: host.now(),
      stat: 'R+',
      cpu: 0,
      rss: 3720,
      vsz: 226480,
      tty: 'pts/0',
      label: 'unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023',
      transient: true,
    };
    return { list: [...host.listProcesses(), self], self };
  },

  _cmd_ps(args) {
    const host = this.host;
    const { list, self } = this._psRows();
    let bsd = false;
    let all = false;
    let full = false;
    let userFormat = false;
    let label = false;
    let users = null;
    let pids = null;
    let commands = null;
    let format = null;
    let sort = null;
    let noHeader = false;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg.startsWith('--sort')) {
        sort = arg.includes('=') ? arg.slice(7) : args[++index];
        continue;
      }
      if (arg === '--no-headers' || arg === '--no-heading') {
        noHeader = true;
        continue;
      }
      if (arg === '-o' || arg === '-O' || arg === 'o' || arg === '--format') {
        format = args[++index];
        continue;
      }
      if (arg === '-u' || arg === '-U' || arg === '--user') {
        users = String(args[++index] ?? '').split(',');
        continue;
      }
      if (arg === '-p' || arg === '--pid') {
        pids = String(args[++index] ?? '')
          .split(',')
          .map(Number);
        continue;
      }
      if (arg === '-C') {
        commands = String(args[++index] ?? '').split(',');
        continue;
      }
      if (arg.startsWith('-')) {
        for (const char of arg.slice(1)) {
          if (char === 'e' || char === 'A') all = true;
          else if (char === 'f' || char === 'F') full = true;
          else if (char === 'Z') label = true;
          else if (char === 'o') format = args[++index];
        }
        continue;
      }
      if (/^[a-zA-Z]+$/.test(arg)) {
        bsd = true;
        for (const char of arg) {
          if (char === 'a' || char === 'x') all = true;
          else if (char === 'u') userFormat = true;
          else if (char === 'Z') label = true;
          else if (char === 'o') format = args[++index];
        }
        continue;
      }
      if (/^\d+$/.test(arg)) pids = [...(pids || []), Number(arg)];
    }
    let rows = list;
    if (users)
      rows = rows.filter(
        (process) =>
          users.includes(process.user) || users.includes(String(host.users.get(process.user)?.uid))
      );
    else if (pids) rows = rows.filter((process) => pids.includes(process.pid));
    else if (commands) rows = rows.filter((process) => commands.includes(process.comm));
    else if (!all)
      rows = rows.filter(
        (process) => process.tty === 'pts/0' && process.user === host.session.user
      );
    if (bsd && !all && !users && !pids)
      rows = list.filter((process) => process.user === host.session.user && process.tty !== '?');
    const elapsedSeconds = (process) => Math.max(1, (host.now() - process.start) / 1000);
    const pcpu = (process) =>
      process.transient
        ? 0
        : Math.min(99.9, (host.cpuSeconds(process) / elapsedSeconds(process)) * 100);
    const fmtTime = (process, long) => {
      const total = Math.floor(host.cpuSeconds(process));
      if (long)
        return `${String(Math.floor(total / 3600)).padStart(2, '0')}:${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
      return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    };
    const userName = (process) => {
      const name = String(process.user);
      return name.length > 8 ? `${name.slice(0, 7)}+` : name;
    };
    const column = {
      pid: ['PID', (p) => String(p.pid), 'right'],
      ppid: ['PPID', (p) => String(p.ppid), 'right'],
      user: ['USER', (p) => userName(p), 'left'],
      uid: ['UID', (p) => String(host.users.get(p.user)?.uid ?? p.user), 'right'],
      '%cpu': ['%CPU', (p) => pcpu(p).toFixed(1), 'right'],
      pcpu: ['%CPU', (p) => pcpu(p).toFixed(1), 'right'],
      '%mem': ['%MEM', (p) => host.memPercent(p).toFixed(1), 'right'],
      pmem: ['%MEM', (p) => host.memPercent(p).toFixed(1), 'right'],
      vsz: ['VSZ', (p) => String(p.vsz), 'right'],
      rss: ['RSS', (p) => String(p.rss), 'right'],
      tty: ['TT', (p) => p.tty, 'left'],
      stat: ['STAT', (p) => p.stat, 'left'],
      start: ['STARTED', (p) => formatClock(p.start), 'right'],
      time: ['TIME', (p) => fmtTime(p, true), 'right'],
      etime: [
        'ELAPSED',
        (p) => {
          const s = Math.floor(elapsedSeconds(p));
          return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
        },
        'right',
      ],
      ni: ['NI', (p) => String(p.nice ?? 0), 'right'],
      nice: ['NI', (p) => String(p.nice ?? 0), 'right'],
      comm: ['COMMAND', (p) => p.comm, 'left'],
      cmd: ['CMD', (p) => p.args, 'left'],
      args: ['COMMAND', (p) => p.args, 'left'],
      command: ['COMMAND', (p) => p.args, 'left'],
      label: ['LABEL', (p) => p.label, 'left'],
    };
    let spec;
    if (format) {
      spec = String(format)
        .split(/[,\s]+/)
        .filter(Boolean)
        .map((entry) => {
          const [key, rename] = entry.split('=');
          const definition = column[key.toLowerCase()];
          if (!definition) return null;
          return [rename !== undefined ? rename : definition[0], definition[1], definition[2]];
        });
      if (spec.some((entry) => entry === null)) {
        const bad = String(format)
          .split(/[,\s]+/)
          .find((entry) => !column[entry.split('=')[0].toLowerCase()]);
        return fail(
          `error: unknown user-defined format specifier "${bad}"\n\nUsage:\n ps [options]\n\n Try 'ps --help <simple|list|output|threads|misc|all>'\n  or 'ps --help <s|l|o|t|m|a>'\n for additional help text.\n\nFor more details see ps(1).`
        );
      }
    } else if (userFormat) {
      spec = [
        ['USER', (p) => userName(p), 'left'],
        ['PID', (p) => String(p.pid), 'right'],
        ['%CPU', (p) => pcpu(p).toFixed(1), 'right'],
        ['%MEM', (p) => host.memPercent(p).toFixed(1), 'right'],
        ['VSZ', (p) => String(p.vsz), 'right'],
        ['RSS', (p) => String(p.rss), 'right'],
        ['TTY', (p) => p.tty, 'left'],
        ['STAT', (p) => p.stat, 'left'],
        ['START', (p) => formatClock(p.start), 'left'],
        ['TIME', (p) => fmtTime(p, false), 'right'],
        ['COMMAND', (p) => p.args, 'left'],
      ];
    } else if (full) {
      spec = [
        ['UID', (p) => userName(p), 'left'],
        ['PID', (p) => String(p.pid), 'right'],
        ['PPID', (p) => String(p.ppid), 'right'],
        ['C', (p) => String(Math.floor(pcpu(p))), 'right'],
        ['STIME', (p) => formatClock(p.start), 'left'],
        ['TTY', (p) => p.tty, 'left'],
        ['TIME', (p) => fmtTime(p, true), 'right'],
        ['CMD', (p) => p.args, 'left'],
      ];
    } else if (bsd) {
      spec = [
        ['PID', (p) => String(p.pid), 'right'],
        ['TTY', (p) => p.tty, 'left'],
        ['STAT', (p) => p.stat, 'left'],
        ['TIME', (p) => fmtTime(p, false), 'right'],
        ['COMMAND', (p) => p.args, 'left'],
      ];
    } else {
      spec = [
        ['PID', (p) => String(p.pid), 'right'],
        ['TTY', (p) => p.tty, 'left'],
        ['TIME', (p) => fmtTime(p, true), 'right'],
        ['CMD', (p) => p.comm, 'left'],
      ];
    }
    if (label) spec.unshift(['LABEL', (p) => p.label, 'left']);
    if (sort) {
      const keys = String(sort).split(',');
      rows = [...rows].sort((a, b) => {
        for (const key of keys) {
          const descending = key.startsWith('-');
          const name = key.replace(/^[-+]/, '').toLowerCase();
          const value = (p) =>
            name === '%cpu' || name === 'pcpu'
              ? pcpu(p)
              : name === '%mem' || name === 'pmem'
                ? host.memPercent(p)
                : name === 'pid'
                  ? p.pid
                  : name === 'rss'
                    ? p.rss
                    : name === 'vsz'
                      ? p.vsz
                      : name === 'start' || name === 'start_time'
                        ? p.start
                        : name === 'user'
                          ? p.user
                          : name === 'comm'
                            ? p.comm
                            : p.pid;
          const left = value(a);
          const right = value(b);
          if (left === right) continue;
          const order = left < right ? -1 : 1;
          return descending ? -order : order;
        }
        return a.pid - b.pid;
      });
    }
    // procps minimum widths (USER 8, PID 7, …) keep real alignment.
    const minWidth = {
      USER: 8,
      UID: 8,
      PID: 7,
      PPID: 7,
      '%CPU': 4,
      '%MEM': 4,
      VSZ: 6,
      RSS: 5,
      TTY: 8,
      TT: 8,
      STAT: 4,
      START: 5,
      TIME: userFormat || bsd ? 6 : 8,
      C: 2,
      STIME: 5,
    };
    const lines = [];
    const widths = spec.map(([header, getter], index) => {
      if (index === spec.length - 1) return 0;
      return Math.max(
        minWidth[header] || header.length,
        header.length,
        ...rows.map((row) => getter(row).length)
      );
    });
    const render = (cells) =>
      cells
        .map((cell, index) => {
          if (index === cells.length - 1) return cell;
          return spec[index][2] === 'right'
            ? cell.padStart(widths[index])
            : cell.padEnd(widths[index]);
        })
        .join(' ');
    if (!noHeader) lines.push(render(spec.map(([header]) => header)));
    for (const row of rows) lines.push(render(spec.map(([, getter]) => getter(row))));
    void self;
    return ok(lines.join('\n'));
  },

  _cmd_pgrep(args) {
    const { flags, values, positionals } = parseArgs(args, { valueShort: 'uUd' });
    const pattern = positionals[0];
    if (!pattern && !values.has('u'))
      return fail(
        "pgrep: no matching criteria specified\nTry `pgrep --help' for more information.",
        2
      );
    let matches = this.host.findProcesses(pattern ?? '.', {
      full: flags.has('f'),
      user: values.get('u'),
      exact: flags.has('x'),
    });
    matches = matches.filter((process) => !process.kernel || !pattern);
    if (!matches.length) return { error: false, message: '', exitCode: 1 };
    const separator = values.get('d') ?? '\n';
    const lines = matches.map((process) =>
      flags.has('a')
        ? `${process.pid} ${process.args}`
        : flags.has('l')
          ? `${process.pid} ${process.comm}`
          : String(process.pid)
    );
    if (flags.has('c')) return ok(String(matches.length));
    return ok(lines.join(separator));
  },

  _cmd_pkill(args) {
    const { flags, values, positionals } = parseArgs(
      args.filter((arg) => !/^-(\d+|[A-Z]+|SIG[A-Z]+)$/.test(arg)),
      { valueShort: 'uU' }
    );
    const signalArg = args.find((arg) => /^-(\d+|[A-Z]+|SIG[A-Z]+)$/.test(arg));
    const signal = signalArg ? parseSignal(signalArg.slice(1)) : 15;
    if (signal === null) return fail(`pkill: unknown signal name ${signalArg.slice(1)}`, 2);
    const pattern = positionals[0];
    if (!pattern && !values.has('u'))
      return fail(
        "pkill: no matching criteria specified\nTry `pkill --help' for more information.",
        2
      );
    const matches = this.host
      .findProcesses(pattern ?? '.', {
        full: flags.has('f'),
        user: values.get('u'),
        exact: flags.has('x'),
      })
      .filter((process) => !process.kernel);
    if (!matches.length) return { error: false, message: '', exitCode: 1 };
    const errors = [];
    let killed = 0;
    for (const process of matches) {
      const result = this.host.kill(process.pid, signal, { user: this._user() });
      if (result.error === 'EPERM')
        errors.push(`pkill: killing pid ${process.pid} failed: Operation not permitted`);
      else if (result.ok) killed += 1;
    }
    if (errors.length) return { error: true, message: errors.join('\n'), exitCode: killed ? 0 : 3 };
    return ok('');
  },

  _cmd_killall(args) {
    const signalArg = args.find((arg) => /^-(\d+|[A-Z]+|SIG[A-Z]+)$/.test(arg));
    const signal = signalArg ? parseSignal(signalArg.slice(1)) : 15;
    const names = args.filter((arg) => !arg.startsWith('-'));
    const errors = [];
    for (const name of names) {
      const matches = this.host.listProcesses().filter((process) => process.comm === name);
      if (!matches.length) errors.push(`${name}: no process found`);
      for (const process of matches) {
        const result = this.host.kill(process.pid, signal ?? 15, { user: this._user() });
        if (result.error === 'EPERM')
          errors.push(`${name}(${process.pid}): Operation not permitted`);
      }
    }
    return errors.length ? fail(errors.join('\n')) : ok('');
  },

  _cmd_kill(args) {
    if (!args.length)
      return fail(
        'kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]',
        2
      );
    if (args[0] === '-l' || args[0] === '-L') {
      if (args[1]) {
        const number = Number(args[1]);
        if (Number.isFinite(number))
          return ok(
            SIGNAL_NAMES[number > 128 ? number - 128 : number] ||
              `bash: kill: ${args[1]}: invalid signal specification`
          );
        const parsed = parseSignal(args[1]);
        return parsed === null
          ? fail(`bash: kill: ${args[1]}: invalid signal specification`)
          : ok(String(parsed));
      }
      return ok(killList());
    }
    let signal = 15;
    let index = 0;
    if (args[0] === '-s' || args[0] === '-n') {
      signal = parseSignal(args[1]);
      if (signal === null) return fail(`bash: kill: ${args[1]}: invalid signal specification`);
      index = 2;
    } else if (/^-/.test(args[0])) {
      signal = parseSignal(args[0].slice(1));
      if (signal === null)
        return fail(`bash: kill: ${args[0].slice(1)}: invalid signal specification`);
      index = 1;
    }
    const errors = [];
    for (const target of args.slice(index)) {
      if (target.startsWith('%')) {
        errors.push(`bash: kill: ${target}: no such job`);
        continue;
      }
      if (!/^-?\d+$/.test(target)) {
        errors.push(`bash: kill: ${target}: arguments must be process or job IDs`);
        continue;
      }
      const result = this.host.kill(Number(target), signal, { user: this._user() });
      if (result.error === 'ESRCH') errors.push(`bash: kill: (${target}) - No such process`);
      else if (result.error === 'EPERM')
        errors.push(`bash: kill: (${target}) - Operation not permitted`);
    }
    return errors.length ? fail(errors.join('\n')) : ok('');
  },

  _cmd_top(args) {
    // `top pods` / `top nodes` is the historical unprefixed `oc adm top` form.
    if (args.some((arg) => /^(pods?|po|nodes?|no)$/i.test(arg))) {
      return this.bar?._cmdAdm
        ? this.bar._cmdAdm(['top', ...args], {})
        : fail('top: unknown option');
    }
    const host = this.host;
    const { flags, values } = parseArgs(args, { valueShort: 'ndpuo' });
    if (!flags.has('b')) {
      // An interactive full-screen top cannot run in this terminal; print one batch frame.
    }
    const now = host.now();
    const processes = host.listProcesses();
    const busy = processes.filter((process) => process.cpu >= 1);
    const running = busy.length + 1;
    const usTotal = Math.min(100, busy.reduce((sum, process) => sum + process.cpu, 0) / 2);
    const mem = host.memory();
    const seconds = Math.floor((now - host.bootTime) / 1000);
    const up = `${String(Math.floor(seconds / 3600)).padStart(2)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}`;
    const load = host
      .loadAverage()
      .map((value) => value.toFixed(2))
      .join(', ');
    const mib = (kib) => (kib / 1024).toFixed(1).padStart(8);
    const header = [
      `top - ${new Date(now).toISOString().slice(11, 19)} up ${up},  1 user,  load average: ${load}`,
      `Tasks: ${String(processes.length + 1).padStart(3)} total, ${String(running).padStart(3)} running, ${String(processes.length + 1 - running).padStart(3)} sleeping,   0 stopped,   0 zombie`,
      `%Cpu(s): ${usTotal.toFixed(1).padStart(4)} us,  ${(usTotal > 0 ? 0.0 : 3.1).toFixed(1)} sy,  0.0 ni, ${(100 - usTotal - (usTotal > 0 ? 0 : 3.1)).toFixed(1).padStart(4)} id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st`,
      `MiB Mem : ${mib(mem.total)} total, ${mib(mem.free)} free, ${mib(mem.used)} used, ${mib(mem.cache)} buff/cache`,
      `MiB Swap:      0.0 total,      0.0 free,      0.0 used. ${mib(mem.available)} avail Mem`,
      '',
      '    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND',
    ];
    let rows = processes.filter((process) => !values.has('u') || process.user === values.get('u'));
    if (values.has('p'))
      rows = rows.filter((process) =>
        String(values.get('p')).split(',').map(Number).includes(process.pid)
      );
    rows = [...rows].sort((a, b) => b.cpu - a.cpu || a.pid - b.pid);
    const timePlus = (process) => {
      const total = host.cpuSeconds(process);
      const minutes = Math.floor(total / 60);
      return `${minutes}:${(total % 60).toFixed(2).padStart(5, '0')}`;
    };
    const lines = rows.map((process) => {
      const state =
        process.stat.charAt(0) === 'I' ? 'I' : process.cpu >= 1 ? 'R' : process.stat.charAt(0);
      return [
        String(process.pid).padStart(7),
        String(process.user).slice(0, 8).padEnd(8),
        (process.kernel && /^I/.test(process.stat) ? '0' : '20').padStart(4),
        String(process.kernel && /^I/.test(process.stat) ? -20 : (process.nice ?? 0)).padStart(3),
        String(process.vsz).padStart(7),
        String(process.rss).padStart(6),
        String(Math.round(process.rss * 0.7)).padStart(6),
        state,
        process.cpu.toFixed(1).padStart(5),
        host.memPercent(process).toFixed(1).padStart(5),
        timePlus(process).padStart(9),
        process.comm,
      ].join(' ');
    });
    return ok([...header, ...lines].join('\n'));
  },

  // ── systemd ──────────────────────────────────────────────────────────────

  _cmd_systemctl(args) {
    const host = this.host;
    const { flags, values, longs, positionals } = parseArgs(args, {
      valueShort: 'tpn',
      valueLong: ['type', 'state', 'property', 'lines'],
    });
    const quiet = flags.has('q') || longs.has('quiet');
    let [verb, ...units] = positionals;
    if (longs.has('failed')) {
      verb = verb || 'list-units';
      longs.set('state', 'failed');
    }
    if (!verb) verb = 'list-units';
    const root = this._user() === 'root';
    const polkit = (action, unit) =>
      fail(
        action === 'enable' || action === 'disable' || action === 'mask' || action === 'unmask'
          ? `Failed to ${action} unit: Interactive authentication required.`
          : action === 'daemon-reload'
            ? 'Failed to reload daemon: Interactive authentication required.'
            : `Failed to ${action} ${unit}: Interactive authentication required.\nSee system logs and 'systemctl status ${unit}' for details.`
      );
    const typeFilter = values.get('t') || longs.get('type') || null;
    const stateFilter = longs.get('state') || null;
    switch (verb) {
      case 'status':
        return this._systemctlStatus(units, {
          lines: Number(values.get('n') ?? longs.get('lines') ?? 10),
        });
      case 'start':
      case 'stop':
      case 'restart':
      case 'try-restart':
      case 'reload':
      case 'reload-or-restart': {
        if (!units.length) return fail(`Too few arguments.`);
        const messages = [];
        for (const raw of units) {
          const name = host.unitName(raw);
          if (!root)
            return polkit(
              verb === 'try-restart' || verb === 'reload-or-restart' ? 'restart' : verb,
              name
            );
          const unit = host.getUnit(raw);
          if (!unit) {
            if (verb === 'stop') return fail(`Failed to stop ${name}: Unit ${name} not loaded.`, 5);
            return fail(
              `Failed to ${verb === 'reload' ? 'reload' : verb === 'start' ? 'start' : 'restart'} ${name}: Unit ${name} not found.`,
              5
            );
          }
          let result;
          if (verb === 'start') result = host.startUnit(raw);
          else if (verb === 'stop') result = host.stopUnit(raw);
          else if (verb === 'reload') result = host.reloadUnit(raw);
          else if (verb === 'try-restart')
            result = unit.active === 'active' ? host.restartUnit(raw) : { ok: true };
          else if (verb === 'reload-or-restart')
            result =
              unit.active === 'active' && unit.def?.reload
                ? host.reloadUnit(raw)
                : host.restartUnit(raw);
          else result = host.restartUnit(raw);
          if (result.error === 'masked')
            return fail(`Failed to ${verb} ${name}: Unit ${name} is masked.`);
          if (result.error === 'not-active')
            return fail(
              `Failed to reload ${name}: Job type reload is not applicable for unit ${name}.`
            );
          if (result.error === 'no-reload')
            return fail(
              `Failed to reload ${name}: Job type reload is not applicable for unit ${name}.`
            );
          if (result.error === 'reload-failed') {
            return fail(
              `Job for ${name} failed because the control process exited with error code.\nSee "systemctl status ${name}" and "journalctl -xeu ${name}" for details.`
            );
          }
          if (result.error) {
            return fail(
              `Job for ${name} failed because the control process exited with error code.\nSee "systemctl status ${name}" and "journalctl -xeu ${name}" for details.`
            );
          }
          if (unit.needsReload)
            messages.push(
              `Warning: The unit file, source configuration file or drop-ins of ${name} changed on disk. Run 'systemctl daemon-reload' to reload units.`
            );
        }
        return ok(quiet ? '' : messages.join('\n'));
      }
      case 'enable':
      case 'disable': {
        if (!units.length) return fail('Too few arguments.');
        if (!root) return polkit(verb, units[0]);
        const messages = [];
        for (const raw of units) {
          const name = host.unitName(raw);
          if (!host.getUnit(raw))
            return fail(`Failed to ${verb} unit: Unit file ${name} does not exist.`);
          const result =
            verb === 'enable'
              ? host.enableUnit(raw, { now: longs.has('now') })
              : host.disableUnit(raw, { now: longs.has('now') });
          if (result.error === 'static') {
            messages.push(STATIC_UNIT_MESSAGE);
            continue;
          }
          if (result.error === 'masked')
            return fail(`Failed to enable unit: Unit file /etc/systemd/system/${name} is masked.`);
          messages.push(...(result.messages || []));
          if (result.error === 'failed') {
            return fail(
              [
                ...messages,
                `Job for ${name} failed because the control process exited with error code.`,
                `See "systemctl status ${name}" and "journalctl -xeu ${name}" for details.`,
              ].join('\n')
            );
          }
        }
        return ok(quiet ? '' : messages.join('\n'));
      }
      case 'mask':
      case 'unmask': {
        if (!root) return polkit(verb, units[0]);
        const messages = [];
        for (const raw of units) {
          const result = verb === 'mask' ? host.maskUnit(raw) : host.unmaskUnit(raw);
          if (result.error)
            return fail(`Failed to ${verb} unit: Unit file ${host.unitName(raw)} does not exist.`);
          messages.push(...result.messages);
        }
        return ok(messages.join('\n'));
      }
      case 'is-active':
      case 'is-failed':
      case 'is-enabled': {
        if (!units.length) return fail('Too few arguments.');
        const lines = [];
        let anyOk = false;
        for (const raw of units) {
          const unit = host.getUnit(raw);
          if (verb === 'is-enabled') {
            if (!unit) {
              return fail(
                `Failed to get unit file state for ${host.unitName(raw)}: No such file or directory`
              );
            }
            lines.push(unit.enabled);
            if (unit.enabled === 'enabled' || unit.enabled === 'static' || unit.enabled === 'alias')
              anyOk = true;
            continue;
          }
          const state = unit ? unit.active : 'inactive';
          lines.push(state);
          if (verb === 'is-active' && state === 'active') anyOk = true;
          if (verb === 'is-failed' && state === 'failed') anyOk = true;
        }
        return withStatus(quiet ? '' : lines.join('\n'), anyOk ? 0 : verb === 'is-active' ? 3 : 1);
      }
      case 'list-units':
        return this._systemctlListUnits({
          typeFilter,
          stateFilter,
          all: flags.has('a') || longs.has('all'),
          patterns: units,
        });
      case 'list-unit-files':
        return this._systemctlListUnitFiles({ typeFilter, patterns: units });
      case 'cat': {
        if (!units.length) return fail('Too few arguments.');
        const out = [];
        for (const raw of units) {
          const unit = host.getUnit(raw);
          if (!unit) return fail(`No files found for ${host.unitName(raw)}.`);
          const read = host.readFile(unit.unitPath, { user: 'root' });
          out.push(`# ${unit.unitPath}`, (read.content || '').replace(/\n$/, ''));
        }
        return ok(out.join('\n'));
      }
      case 'show': {
        const unit = host.getUnit(units[0] || '');
        if (!unit) return fail(`Unit ${host.unitName(units[0] || '')} could not be found.`, 4);
        const properties = {
          Id: unit.name,
          Description: unit.def?.description || unit.name,
          LoadState: 'loaded',
          ActiveState: unit.active,
          SubState: unit.sub,
          UnitFileState: unit.enabled,
          UnitFilePreset: unit.preset,
          FragmentPath: unit.unitPath,
          MainPID: String(unit.mainPid || 0),
          ExecMainStatus: String(unit.exitStatus || 0),
          Result: unit.result || 'success',
          User: unit.def?.user && unit.def.user !== 'root' ? unit.def.user : '',
        };
        const wanted = (values.get('p') || longs.get('property') || '').split(',').filter(Boolean);
        const keys = wanted.length ? wanted : Object.keys(properties);
        return ok(
          keys
            .map((key) =>
              longs.has('value') ? (properties[key] ?? '') : `${key}=${properties[key] ?? ''}`
            )
            .join('\n')
        );
      }
      case 'daemon-reload':
        if (!root) return polkit('daemon-reload');
        host.daemonReload();
        return ok('');
      case 'reset-failed':
        if (!root)
          return fail('Failed to reset failed state of unit: Interactive authentication required.');
        host.resetFailed(units[0]);
        return ok('');
      case 'get-default':
        return ok('multi-user.target');
      case 'list-dependencies':
        return ok(
          `${units[0] ? host.unitName(units[0]) : 'default.target'}\n● ├─system.slice\n● └─sysinit.target`
        );
      case 'edit':
        return fail(
          `(simulator) systemctl edit opens an editor on a real system. Create a drop-in instead: sudo mkdir -p /etc/systemd/system/${host.unitName(units[0] || 'unit')}.d && sudo vim /etc/systemd/system/${host.unitName(units[0] || 'unit')}.d/override.conf`
        );
      case 'reboot':
      case 'poweroff':
      case 'halt':
        if (!root)
          return fail(
            `Call to ${verb === 'reboot' ? 'Reboot' : 'PowerOff'} failed: Interactive authentication required.`
          );
        return fail(
          `(simulator) ${verb} is disabled on the lab workstation — the level state would be lost.`
        );
      default:
        return fail(`Unknown command verb ${verb}.`);
    }
  },

  _systemctlStatus(units, { lines = 10 } = {}) {
    const host = this.host;
    const now = host.now();
    if (!units.length) {
      const failed = [...host.units.values()].filter((unit) => unit.active === 'failed').length;
      return ok(
        [
          `● ${host.hostname}`,
          `    State: ${failed ? 'degraded' : 'running'}`,
          `    Units: ${host.units.size + 152} loaded (incl. loaded aliases)`,
          `     Jobs: 0 queued`,
          `   Failed: ${failed} units`,
          `    Since: ${formatSystemdTime(host.bootTime)}; ${formatRelative(host.bootTime, now)}`,
          '  systemd: 252-51.el9',
          '   CGroup: /',
        ].join('\n')
      );
    }
    const blocks = [];
    let exitCode = 0;
    for (const raw of units) {
      if (/^\d+$/.test(raw)) {
        const process = host.processes.get(Number(raw));
        const unit = process?.unit ? host.units.get(process.unit) : null;
        if (!unit) {
          exitCode = 4;
          blocks.push(
            `Failed to get unit for PID ${raw}: PID ${raw} does not belong to any loaded unit.`
          );
          continue;
        }
        units.push(unit.name);
        continue;
      }
      const unit = host.getUnit(raw);
      const name = host.unitName(raw);
      if (!unit) {
        exitCode = Math.max(exitCode, 4);
        blocks.push(`Unit ${name} could not be found.`);
        continue;
      }
      const def = unit.def || {};
      const bullet = unit.active === 'active' ? '●' : unit.active === 'failed' ? '×' : '○';
      const out = [`${bullet} ${unit.name} - ${def.description || unit.name}`];
      const loadState =
        unit.enabled === 'static' ? 'static' : `${unit.enabled}; preset: ${unit.preset}`;
      out.push(
        unit.enabled === 'masked'
          ? '     Loaded: masked (Reason: Unit ' + unit.name + ' is masked.)'
          : `     Loaded: loaded (${unit.unitPath}; ${loadState})`
      );
      if (unit.active === 'active') {
        out.push(
          `     Active: active (running) since ${formatSystemdTime(unit.since)}; ${formatRelative(unit.since, now)}`
        );
      } else if (unit.active === 'failed') {
        out.push(
          `     Active: failed (Result: ${unit.result}) since ${formatSystemdTime(unit.since)}; ${formatRelative(unit.since, now)}`
        );
      } else if (unit.since) {
        out.push(
          `     Active: inactive (dead) since ${formatSystemdTime(unit.since)}; ${formatRelative(unit.since, now)}`
        );
      } else out.push('     Active: inactive (dead)');
      (def.docs || []).forEach((doc, index) =>
        out.push(index === 0 ? `       Docs: ${doc}` : `             ${doc}`)
      );
      if (unit.active === 'failed') {
        const code = unit.result === 'signal' ? 'killed' : 'exited';
        const status = `${unit.exitStatus}/${unit.exitStatusText || (unit.exitStatus === 1 ? 'FAILURE' : String(unit.exitStatus))}`;
        out.push(
          `    Process: ${unit.failedPid} ExecStart=${def.exec || def.cmd} (code=${code}, status=${status})`
        );
        out.push(`   Main PID: ${unit.failedPid} (code=${code}, status=${status})`);
        if (def.statusText && unit.short === 'httpd')
          out.push('     Status: "Reading configuration..."');
        out.push(`        CPU: ${unit.cpuMs || 31}ms`);
      } else if (unit.active === 'active') {
        out.push(`   Main PID: ${unit.mainPid} (${def.comm || unit.short})`);
        if (def.statusText) out.push(`     Status: "${def.statusText}"`);
        out.push(`      Tasks: ${def.tasks ?? unit.pids.length} (limit: 22964)`);
        out.push(`     Memory: ${def.memory || '1.2M'}`);
        out.push(`        CPU: ${unit.cpuMs || 120}ms`);
        out.push(`     CGroup: /system.slice/${unit.name}`);
        unit.pids.forEach((pid, index) => {
          const process = host.processes.get(pid);
          if (!process) return;
          out.push(
            `             ${index === unit.pids.length - 1 ? '└─' : '├─'}${pid} ${process.args}`
          );
        });
      }
      const entries = host.journal
        .filter((entry) => entry.unit === unit.name && !entry.boot)
        .slice(-lines);
      if (entries.length && lines > 0) {
        out.push('');
        for (const entry of entries) out.push(this._journalLine(entry));
      }
      if (unit.active !== 'active') exitCode = Math.max(exitCode, 3);
      blocks.push(out.join('\n'));
    }
    return withStatus(blocks.join('\n\n'), exitCode);
  },

  _systemctlListUnits({ typeFilter, stateFilter, all, patterns }) {
    const host = this.host;
    const rows = [];
    for (const unit of [...host.units.values()].sort((a, b) => collateNames(a.name, b.name))) {
      if (!all && unit.active === 'inactive' && !stateFilter) continue;
      rows.push({
        name: unit.name,
        load: unit.enabled === 'masked' ? 'masked' : 'loaded',
        active: unit.active,
        sub: unit.sub,
        description: unit.def?.description || unit.name,
        failed: unit.active === 'failed',
      });
    }
    if (!typeFilter || typeFilter !== 'service') {
      for (const [name, description, sub] of OTHER_UNIT_ROWS) {
        const type = name.split('.').pop();
        if (typeFilter && type !== typeFilter) continue;
        rows.push({ name, load: 'loaded', active: 'active', sub, description, failed: false });
      }
    }
    let selected = rows.filter((row) => !typeFilter || row.name.endsWith(`.${typeFilter}`));
    if (stateFilter)
      selected = selected.filter((row) => row.active === stateFilter || row.sub === stateFilter);
    if (patterns.length)
      selected = selected.filter((row) =>
        patterns.some(
          (pattern) => globMatch(pattern, row.name) || globMatch(`${pattern}.service`, row.name)
        )
      );
    selected.sort((a, b) => collateNames(a.name, b.name));
    const body = table(
      [
        ['UNIT', 'LOAD', 'ACTIVE', 'SUB', 'DESCRIPTION'],
        ...selected.map((row) => [row.name, row.load, row.active, row.sub, row.description]),
      ],
      { gap: ' ' }
    )
      .split('\n')
      .map((line, index) => `${index > 0 && selected[index - 1].failed ? '●' : ' '} ${line}`);
    // systemd 252 output_units_list(): the header is always printed, the legend only
    // with rows, and the count line depends on --all / --state.
    const footer = [];
    if (selected.length) {
      footer.push(
        '',
        'LOAD   = Reflects whether the unit definition was properly loaded.',
        'ACTIVE = The high-level unit activation state, i.e. generalization of SUB.',
        'SUB    = The low-level unit activation state, values depend on unit type.',
        ''
      );
    }
    if (all) {
      footer.push(
        `${selected.length} loaded units listed.`,
        "To show all installed unit files use 'systemctl list-unit-files'."
      );
    } else if (!stateFilter) {
      footer.push(
        `${selected.length} loaded units listed. Pass --all to see loaded but inactive units, too.`,
        "To show all installed unit files use 'systemctl list-unit-files'."
      );
    } else footer.push(`${selected.length} loaded units listed.`);
    const header = selected.length ? body : ['  UNIT LOAD ACTIVE SUB DESCRIPTION'];
    return ok([...header, ...footer].join('\n'));
  },

  _systemctlListUnitFiles({ typeFilter, patterns }) {
    const host = this.host;
    let rows = [...host.units.values()].map((unit) => [
      unit.name,
      unit.enabled,
      unit.preset === 'static' ? '-' : unit.preset,
    ]);
    if (!typeFilter || typeFilter !== 'service') {
      for (const [name] of OTHER_UNIT_ROWS)
        rows.push([
          name,
          name.endsWith('.target') || name.endsWith('.mount') ? 'static' : 'enabled',
          name.endsWith('.timer') ? 'enabled' : '-',
        ]);
    }
    if (typeFilter) rows = rows.filter((row) => row[0].endsWith(`.${typeFilter}`));
    if (patterns.length)
      rows = rows.filter((row) => patterns.some((pattern) => globMatch(pattern, row[0])));
    rows.sort((a, b) => collateNames(a[0], b[0]));
    return ok(
      `${table([['UNIT FILE', 'STATE', 'PRESET'], ...rows], { gap: ' ' })}\n\n${rows.length} unit files listed.`
    );
  },

  /** One journal entry in journalctl's short format. */
  _journalLine(entry, { output = 'short' } = {}) {
    if (output === 'cat') return entry.message;
    const ident = entry.pid ? `${entry.ident}[${entry.pid}]` : entry.ident;
    if (output === 'short-iso')
      return `${new Date(entry.time).toISOString().replace(/\.\d+Z$/, '+0000')} ${this.host.hostname} ${ident}: ${entry.message}`;
    return `${formatJournalTime(entry.time)} ${this.host.hostname} ${ident}: ${entry.message}`;
  },

  _cmd_journalctl(args) {
    const host = this.host;
    const { flags, values, longs, positionals } = parseArgs(args, {
      valueShort: 'unpto',
      valueLong: ['unit', 'lines', 'priority', 'since', 'until', 'identifier', 'output', 'boot'],
    });
    const units = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '-u' || args[index] === '--unit') units.push(args[index + 1]);
      else if (args[index].startsWith('--unit=')) units.push(args[index].slice(7));
      else if (/^-u\S+$/.test(args[index])) units.push(args[index].slice(2));
    }
    if (longs.has('list-boots')) {
      return ok(
        `IDX BOOT ID                          FIRST ENTRY                 LAST ENTRY                 \n  0 ${fakeSha256(`boot-${host.bootTime}`).slice(0, 32)} ${formatSystemdTime(host.bootTime)} ${formatSystemdTime(host.now())}`
      );
    }
    if (longs.has('disk-usage'))
      return ok('Archived and active journals take up 16.0M in the file system.');
    const identity = host.identity(this._user());
    const privileged = identity.uid === 0 || [4, 10, 190].some((gid) => identity.gids.has(gid));
    let entries = [...host.journal].sort((a, b) => a.time - b.time || a.seq - b.seq);
    if (!privileged) entries = entries.filter((entry) => entry.user === identity.name);
    if (units.length) {
      const names = units.map((unit) => host.unitName(unit));
      entries = entries.filter((entry) => names.includes(entry.unit));
    }
    if (flags.has('k') || longs.has('dmesg'))
      entries = entries.filter((entry) => entry.ident === 'kernel');
    const identifier = values.get('t') || longs.get('identifier');
    if (identifier) entries = entries.filter((entry) => entry.ident === identifier);
    const priority = values.get('p') ?? longs.get('priority');
    if (priority !== undefined && priority !== true) {
      const levels = {
        emerg: 0,
        alert: 1,
        crit: 2,
        err: 3,
        warning: 4,
        notice: 5,
        info: 6,
        debug: 7,
      };
      const text = String(priority);
      const [low, high] = text.includes('..') ? text.split('..') : [null, text];
      const max = /^\d$/.test(high) ? Number(high) : levels[high];
      const min = low === null ? 0 : /^\d$/.test(low) ? Number(low) : levels[low];
      if (max === undefined) return fail(`Failed to parse log level: ${text}`);
      entries = entries.filter((entry) => entry.priority <= max && entry.priority >= (min ?? 0));
    }
    for (const match of positionals) {
      const pid = match.match(/^_PID=(\d+)$/);
      if (pid) entries = entries.filter((entry) => String(entry.pid) === pid[1]);
      const unitMatch = match.match(/^_SYSTEMD_UNIT=(.+)$/);
      if (unitMatch)
        entries = entries.filter((entry) => entry.unit === host.unitName(unitMatch[1]));
    }
    const since = values.get('S') ?? longs.get('since');
    if (since) {
      const time = parseJournalTime(String(since), host.now());
      if (time === null) return fail(`Failed to parse timestamp: ${since}`);
      entries = entries.filter((entry) => entry.time >= time);
    }
    const until = values.get('U') ?? longs.get('until');
    if (until) {
      const time = parseJournalTime(String(until), host.now());
      if (time === null) return fail(`Failed to parse timestamp: ${until}`);
      entries = entries.filter((entry) => entry.time <= time);
    }
    let limit = null;
    if (values.has('n') || longs.has('lines')) {
      const value = values.get('n') ?? longs.get('lines');
      limit = value === 'all' ? null : Number.parseInt(value, 10);
      if (value !== 'all' && !Number.isFinite(limit))
        return fail(`Failed to parse lines '${value}'.`);
    } else if (flags.has('f') || longs.has('follow')) limit = 10;
    else if (flags.has('e') || longs.has('pager-end')) limit = 1000;
    if (limit !== null) entries = entries.slice(-limit);
    if (flags.has('r') || longs.has('reverse')) entries = entries.reverse();
    const output = values.get('o') || longs.get('output') || 'short';
    const explain = flags.has('x') || longs.has('catalog');
    const lines = [];
    for (const entry of entries) {
      lines.push(this._journalLine(entry, { output }));
      if (explain && entry.catalog) lines.push(...catalogLines(entry.catalog));
    }
    if (!lines.length) lines.push('-- No entries --');
    if (!privileged && !flags.has('q')) {
      lines.unshift(
        "Hint: You are currently not seeing messages from other users and the system.\n      Users in groups 'adm', 'systemd-journal', 'wheel' can see all messages.\n      Pass -q to turn off this notice."
      );
    }
    return ok(lines.join('\n'));
  },

  // ── network ──────────────────────────────────────────────────────────────

  _cmd_ip(args) {
    const host = this.host;
    let family = null;
    let brief = false;
    const rest = [];
    for (const arg of args) {
      if (arg === '-4') family = 4;
      else if (arg === '-6') family = 6;
      else if (arg === '-br' || arg === '-brief' || arg === '--brief') brief = true;
      else if (arg === '-c' || arg === '-color' || arg.startsWith('--color') || arg === '-s')
        continue;
      else rest.push(arg);
    }
    const [object = 'help', ...tail] = rest;
    const objects = {
      a: 'addr',
      addr: 'addr',
      address: 'addr',
      r: 'route',
      ro: 'route',
      route: 'route',
      l: 'link',
      link: 'link',
      n: 'neigh',
      neigh: 'neigh',
      neighbor: 'neigh',
      neighbour: 'neigh',
    };
    const kind = objects[object];
    if (!kind) {
      if (object === 'help')
        return fail(
          'Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }\n       ip [ -force ] -batch filename\nwhere  OBJECT := { address | addrlabel | amt | fou | help | ila | ioam | l2tp | link |\n                   macsec | maddress | monitor | mptcp | mroute | mrule |\n                   neighbor | neighbour | netconf | netns | nexthop | ntable |\n                   ntbl | route | rule | sr | stats | tap | tcpmetrics |\n                   token | tunnel | tuntap | vrf | xfrm }',
          255
        );
      return fail(`Object "${object}" is unknown, try "ip help".`, 255);
    }
    const verb = tail[0] && !['dev', 'eth0', 'lo'].includes(tail[0]) ? tail[0] : 'show';
    if (['add', 'del', 'delete', 'change', 'replace', 'set', 'flush'].includes(verb)) {
      if (this._user() !== 'root') return fail('RTNETLINK answers: Operation not permitted', 2);
      return fail(
        '(simulator) the lab network is managed by NetworkManager: use nmcli to change it.',
        2
      );
    }
    const devIndex = tail.indexOf('dev');
    const devName =
      devIndex >= 0
        ? tail[devIndex + 1]
        : tail.find(
            (word) =>
              ['eth0', 'lo'].includes(word) ||
              (word !== 'show' && word !== 'list' && !word.startsWith('-'))
          );
    const interfaces = host.interfaces();
    if (devName && !interfaces.some((entry) => entry.name === devName))
      return fail(`Device "${devName}" does not exist.`);
    const selected = interfaces.filter((entry) => !devName || entry.name === devName);
    if (kind === 'route') {
      const routes = family === 6 ? [] : host.routes();
      if (family === 6)
        return ok(
          '::1 dev lo proto kernel metric 256 pref medium\nfe80::/64 dev eth0 proto kernel metric 1024 pref medium'
        );
      return ok(
        routes
          .map((route) =>
            route.dest === 'default'
              ? `default via ${route.via} dev ${route.dev} proto ${route.proto} metric ${route.metric} `
              : `${route.dest} dev ${route.dev} proto ${route.proto} scope ${route.scope} src ${route.src} metric ${route.metric} `
          )
          .join('\n')
      );
    }
    if (kind === 'neigh') return ok('172.25.250.254 dev eth0 lladdr 52:54:00:00:fa:fe REACHABLE');
    if (brief) {
      return ok(
        selected
          .map((entry) => {
            if (kind === 'link')
              return `${entry.name.padEnd(16)} ${entry.state.padEnd(14)} ${entry.mac} <${entry.flags}> `;
            const addresses = [
              ...(family === 6 ? [] : entry.inet.map((a) => `${a.address}/${a.prefix}`)),
              ...(family === 4 ? [] : entry.inet6.map((a) => `${a.address}/${a.prefix}`)),
            ];
            return `${entry.name.padEnd(16)} ${entry.state.padEnd(14)} ${addresses.join(' ')} `;
          })
          .join('\n')
      );
    }
    const lines = [];
    for (const entry of selected) {
      const mode = kind === 'link' ? ' mode DEFAULT' : '';
      lines.push(
        `${entry.index}: ${entry.name}: <${entry.flags}> mtu ${entry.mtu} qdisc ${entry.qdisc} state ${entry.state}${mode} group default qlen 1000`
      );
      if (kind === 'link' || family !== 4 || true) {
        if (!(kind === 'addr' && family))
          lines.push(`    link/${entry.linkType} ${entry.mac} brd ${entry.brd}`);
      }
      if (entry.altname && !(kind === 'addr' && family)) lines.push(`    altname ${entry.altname}`);
      if (kind === 'link') continue;
      if (family !== 6) {
        for (const address of entry.inet) {
          lines.push(
            `    inet ${address.address}/${address.prefix}${address.brdAddr ? ` brd ${address.brdAddr}` : ''} scope ${address.scope}${address.noprefixroute ? ' noprefixroute' : ''} ${address.label}`
          );
          lines.push('       valid_lft forever preferred_lft forever');
        }
      }
      if (family !== 4) {
        for (const address of entry.inet6) {
          lines.push(
            `    inet6 ${address.address}/${address.prefix} scope ${address.scope}${address.noprefixroute ? ' noprefixroute' : ''} `
          );
          lines.push('       valid_lft forever preferred_lft forever');
        }
      }
    }
    return ok(lines.join('\n'));
  },

  _cmd_ss(args) {
    const host = this.host;
    const { flags } = parseArgs(args);
    const tcp = flags.has('t');
    const udp = flags.has('u');
    const listening = flags.has('l');
    const numeric = flags.has('n');
    const processes = flags.has('p');
    const showAll = flags.has('a');
    const want = (proto) =>
      !tcp && !udp ? true : (proto === 'tcp' && tcp) || (proto === 'udp' && udp);
    const isRoot = this._user() === 'root';
    const serviceName = (port) =>
      numeric
        ? String(port)
        : {
            22: 'ssh',
            80: 'http',
            443: 'https',
            323: '323',
            3306: 'mysql',
            8080: 'webcache',
            21: 'ftp',
          }[port] || String(port);
    const rows = [];
    if (listening || showAll) {
      for (const socket of host.listeningSockets()) {
        if (!want(socket.proto)) continue;
        const addr = socket.addr === '[::]' || socket.addr === '[::1]' ? socket.addr : socket.addr;
        const peer = addr.startsWith('[') ? '[::]:*' : addr === '*' ? '*:*' : '0.0.0.0:*';
        let process = '';
        if (processes && (isRoot || socket.user === this._user())) {
          const pids = [socket.pid, ...(socket.extraPids || [])].filter(Boolean);
          process = `users:(${pids.map((pid, index) => `("${socket.comm}",pid=${pid},fd=${index === 0 ? socket.fd : socket.fd + 1})`).join(',')})`;
        }
        rows.push({
          netid: socket.proto,
          state: socket.proto === 'udp' ? 'UNCONN' : 'LISTEN',
          recv: '0',
          send: String(socket.backlog),
          local: [
            addr === '0.0.0.0' && socket.proto === 'udp' ? addr : addr,
            serviceName(socket.port),
          ],
          peer: [peer.slice(0, peer.lastIndexOf(':')), '*'],
          process,
        });
      }
    }
    if (!listening) {
      if (want('tcp')) {
        rows.push({
          netid: 'tcp',
          state: 'ESTAB',
          recv: '0',
          send: '0',
          local: [WORKSTATION_IP, serviceName(22)],
          peer: ['172.25.254.254', numeric ? '50822' : '50822'],
          process:
            processes && isRoot ? 'users:(("sshd",pid=2290,fd=4),("sshd",pid=2296,fd=4))' : '',
        });
      }
    }
    const showNetid = (tcp && udp) || (!tcp && !udp);
    const header = [
      ...(showNetid ? ['Netid'] : []),
      'State',
      'Recv-Q',
      'Send-Q',
      'Local Address:Port',
      'Peer Address:Port',
      'Process',
    ];
    const localWidth = Math.max(13, ...rows.map((row) => row.local[0].length));
    const localPort = Math.max(4, ...rows.map((row) => row.local[1].length));
    const peerWidth = Math.max(12, ...rows.map((row) => row.peer[0].length));
    const peerPort = Math.max(4, ...rows.map((row) => row.peer[1].length));
    const lines = [];
    const fmt = (cells, local, peer, process) =>
      `${cells.map((cell, index) => cell.padEnd([5, 6, 6, 6][index + (showNetid ? 0 : 1)] || 6)).join(' ')} ${local} ${peer}${process ? ` ${process}` : ''}`.replace(
        /\s+$/,
        ''
      );
    const headerCells = header.slice(0, showNetid ? 4 : 3);
    lines.push(
      fmt(
        headerCells,
        `${'Local Address'.padStart(localWidth)}:${'Port'.padEnd(localPort)}`,
        `${'Peer Address'.padStart(peerWidth)}:${'Port'.padEnd(peerPort)}`,
        'Process'
      )
    );
    for (const row of rows) {
      const cells = [...(showNetid ? [row.netid] : []), row.state, row.recv, row.send];
      lines.push(
        fmt(
          cells,
          `${row.local[0].padStart(localWidth)}:${row.local[1].padEnd(localPort)}`,
          `${row.peer[0].padStart(peerWidth)}:${row.peer[1].padEnd(peerPort)}`,
          row.process
        )
      );
    }
    return ok(lines.join('\n'));
  },

  _cmd_ping(args) {
    const host = this.host;
    const { values, positionals } = parseArgs(args, { valueShort: 'cWiwsI' });
    const target = positionals[0];
    if (!target) return fail('ping: usage error: Destination address required', 2);
    const countGiven = values.has('c');
    const count = countGiven ? Math.max(1, Number(values.get('c')) || 1) : 4;
    const result = host.ping(target);
    if (result.error === 'unknown-host')
      return fail(`ping: ${target}: Name or service not known`, 2);
    const label = result.name ? `${result.name} (${result.ip})` : result.ip;
    const lines = [`PING ${result.name || result.ip} (${result.ip}) 56(84) bytes of data.`];
    const ttl = host.isLocalAddress(result.ip)
      ? 64
      : result.onLink
        ? 64
        : result.ip === '93.184.216.34'
          ? 52
          : 63;
    const times = [];
    for (let seq = 1; seq <= count; seq += 1) {
      if (result.ok) {
        const time = host.isLocalAddress(result.ip)
          ? 0.035 + (seq % 3) * 0.004
          : 0.38 + (fnv1a(`${target}${seq}`) % 300) / 1000;
        times.push(time);
        lines.push(
          `64 bytes from ${result.name ? `${result.reverse || result.name} (${result.ip})` : result.ip}: icmp_seq=${seq} ttl=${ttl} time=${time.toFixed(3)} ms`
        );
      } else if (!result.onLink) {
        lines.push(`From 172.25.250.254 icmp_seq=${seq} Destination Host Unreachable`);
      }
    }
    if (!countGiven) lines.push('^C');
    lines.push('', `--- ${result.name || result.ip} ping statistics ---`);
    const elapsed = (count - 1) * 1000 + (result.ok ? 2 : 3);
    if (result.ok) {
      const min = Math.min(...times);
      const max = Math.max(...times);
      const avg = times.reduce((sum, value) => sum + value, 0) / times.length;
      const mdev = Math.sqrt(
        times.reduce((sum, value) => sum + (value - avg) ** 2, 0) / times.length
      );
      lines.push(
        `${count} packets transmitted, ${count} received, 0% packet loss, time ${count === 1 ? 0 : elapsed}ms`
      );
      lines.push(
        `rtt min/avg/max/mdev = ${min.toFixed(3)}/${avg.toFixed(3)}/${max.toFixed(3)}/${mdev.toFixed(3)} ms`
      );
      return ok(lines.join('\n'));
    }
    lines.push(
      `${count} packets transmitted, 0 received, ${result.onLink ? '' : `+${count} errors, `}100% packet loss, time ${elapsed}ms`,
      ''
    );
    void label;
    return withStatus(lines.join('\n').replace(/\n$/, ''), 1);
  },

  _cmd_dig(args) {
    const host = this.host;
    let short = false;
    let server = DNS_SERVER_IP;
    let type = 'A';
    let reverse = null;
    const names = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '+short') short = true;
      else if (arg.startsWith('+')) continue;
      else if (arg.startsWith('@')) server = arg.slice(1);
      else if (arg === '-x') reverse = args[++index];
      else if (arg === '-t') type = String(args[++index] || 'A').toUpperCase();
      else if (/^(A|AAAA|MX|NS|TXT|SOA|CNAME|PTR|SRV|ANY)$/i.test(arg)) type = arg.toUpperCase();
      else if (!arg.startsWith('-')) names.push(arg);
    }
    if (server !== DNS_SERVER_IP && !host.isReachable(host.resolveName(server)?.ip || server)) {
      return withStatus(
        `;; communications error to ${server}#53: timed out\n;; communications error to ${server}#53: timed out\n;; communications error to ${server}#53: timed out\n\n; <<>> DiG 9.16.23-RH <<>> ${args.join(' ')}\n;; global options: +cmd\n;; no servers could be reached`,
        9
      );
    }
    const name = reverse
      ? reverse.split('.').reverse().join('.') + '.in-addr.arpa'
      : names[0] || '.';
    let answers = [];
    let status = 'NOERROR';
    if (reverse) {
      const ptr = host.reverseName(reverse) || [...host.dns].find(([, ip]) => ip === reverse)?.[0];
      if (ptr) answers = [[`${name}.`, 3600, 'PTR', `${ptr}.`]];
      else status = 'NXDOMAIN';
      type = 'PTR';
    } else if (names.length) {
      const record = host.dnsLookup(names[0]);
      if (!record) status = 'NXDOMAIN';
      else if (type === 'A' || type === 'ANY')
        answers = [[`${names[0].replace(/\.$/, '')}.`, 3600, 'A', record.ip]];
    } else {
      answers = [['.', 518400, 'NS', 'a.root-servers.net.']];
      type = 'NS';
    }
    if (short) return ok(answers.map((answer) => answer[3]).join('\n'));
    const qname = `${String(name).replace(/\.$/, '')}.`;
    const zone = qname.endsWith('.lab.example.com.')
      ? 'lab.example.com.'
      : qname.endsWith(`.cluster.example.com.`)
        ? 'cluster.example.com.'
        : 'example.com.';
    const authority =
      status === 'NXDOMAIN'
        ? [
            `${zone}\t\t3600\tIN\tSOA\tbastion.lab.example.com. root.bastion.lab.example.com. 2026110801 3600 900 604800 3600`,
          ]
        : [];
    const lines = [
      '',
      `; <<>> DiG 9.16.23-RH <<>> ${args.join(' ')}`.trimEnd(),
      ';; global options: +cmd',
      ';; Got answer:',
      `;; ->>HEADER<<- opcode: QUERY, status: ${status}, id: ${10000 + (fnv1a(qname + host.now()) % 55000)}`,
      `;; flags: qr aa rd ra; QUERY: 1, ANSWER: ${answers.length}, AUTHORITY: ${authority.length}, ADDITIONAL: 1`,
      '',
      ';; OPT PSEUDOSECTION:',
      '; EDNS: version: 0, flags:; udp: 1232',
      `; COOKIE: ${fakeSha256(`cookie-${qname}`).slice(0, 16)}0100000069${fakeSha256('srv').slice(0, 22)} (good)`,
      ';; QUESTION SECTION:',
      `;${qname}${qname.length >= 24 ? '\t' : '\t\t'}IN\t${type}`,
      '',
    ];
    if (answers.length) {
      lines.push(';; ANSWER SECTION:');
      for (const [owner, ttl, recordType, value] of answers)
        lines.push(`${owner}${owner.length >= 24 ? ' ' : '\t'}${ttl}\tIN\t${recordType}\t${value}`);
      lines.push('');
    }
    if (authority.length) lines.push(';; AUTHORITY SECTION:', ...authority, '');
    lines.push(
      ';; Query time: 1 msec',
      `;; SERVER: ${server}#53(${server})`,
      `;; WHEN: ${formatDate(host.now()).replace(/^(\w{3}) (\w{3}) +(\d+)/, (match, day, month, date) => `${day} ${month} ${String(date).padStart(2, '0')}`)}`,
      `;; MSG SIZE  rcvd: ${answers.length ? 68 + qname.length : 110}`,
      ''
    );
    return ok(lines.join('\n').replace(/\n$/, ''));
  },

  _cmd_host(args) {
    const host = this.host;
    const names = args.filter((arg) => !arg.startsWith('-'));
    const name = names[0];
    if (!name)
      return fail(
        'Usage: host [-aCdilrTvVw] [-c class] [-N ndots] [-t type] [-W time]\n            [-R number] [-m flag] [-p port] hostname [server]',
        1
      );
    if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) {
      const ptr = host.reverseName(name);
      const arpa = `${name.split('.').reverse().join('.')}.in-addr.arpa`;
      if (!ptr) return fail(`Host ${arpa} not found: 3(NXDOMAIN)`);
      return ok(`${arpa} domain name pointer ${ptr}.`);
    }
    const record = host.dnsLookupWithSearch(name);
    if (!record) return fail(`Host ${name} not found: 3(NXDOMAIN)`);
    return ok(`${record.name} has address ${record.ip}`);
  },

  _cmd_nslookup(args) {
    const host = this.host;
    const name = args.find((arg) => !arg.startsWith('-'));
    if (!name)
      return fail('(simulator) interactive nslookup is not supported: use nslookup <name>');
    const header = [`Server:\t\t${DNS_SERVER_IP}`, `Address:\t${DNS_SERVER_IP}#53`, ''];
    const record = host.dnsLookupWithSearch(name);
    if (!record)
      return withStatus([...header, `** server can't find ${name}: NXDOMAIN`, ''].join('\n'), 1);
    return ok([...header, `Name:\t${record.name}`, `Address: ${record.ip}`, ''].join('\n'));
  },

  _cmd_getent(args) {
    const host = this.host;
    const [database, ...keys] = args.filter((arg) => !arg.startsWith('-'));
    if (!database)
      return fail(
        "Usage: getent [OPTION...] database [key ...]\nTry `getent --help' or `getent --usage' for more information.",
        1
      );
    const out = [];
    let missing = false;
    if (database === 'hosts' || database === 'ahosts') {
      if (!keys.length) {
        const read = host.readFile('/etc/hosts', { user: 'root' });
        return ok(
          String(read.content || '')
            .split('\n')
            .filter((line) => line.trim() && !line.startsWith('#'))
            .map((line) => {
              const [ip, ...names] = line.trim().split(/\s+/);
              return `${ip.padEnd(15)} ${names.join(' ')}`;
            })
            .join('\n')
        );
      }
      for (const key of keys) {
        const hosts = host.resolveHostsFile(key);
        if (hosts) {
          out.push(`${hosts.ip.padEnd(15)} ${hosts.names.join(' ')}`);
          continue;
        }
        const resolved = host.resolveName(key);
        if (resolved) out.push(`${resolved.ip.padEnd(15)} ${resolved.name}`);
        else missing = true;
      }
    } else if (database === 'passwd' || database === 'group' || database === 'shadow') {
      if (database === 'shadow' && this._user() !== 'root')
        return { error: true, message: '', exitCode: 2, silentFailure: true };
      const content = host._generate(
        database === 'passwd' ? 'passwd' : database === 'group' ? 'group' : 'shadow'
      );
      const lines = content.split('\n').filter(Boolean);
      if (!keys.length) return ok(lines.join('\n'));
      for (const key of keys) {
        const line = lines.find(
          (entry) => entry.split(':')[0] === key || entry.split(':')[2] === key
        );
        if (line) out.push(line);
        else missing = true;
      }
    } else if (database === 'services') {
      const services = {
        ssh: '22/tcp',
        http: '80/tcp',
        https: '443/tcp',
        mysql: '3306/tcp',
        ftp: '21/tcp',
      };
      for (const key of keys) {
        if (services[key]) out.push(`${key.padEnd(21)} ${services[key]}`);
        else missing = true;
      }
    } else
      return fail(
        `Unknown database: ${database}\nTry \`getent --help' or \`getent --usage' for more information.`,
        1
      );
    if (missing && !out.length)
      return { error: true, message: '', exitCode: 2, silentFailure: true };
    return withStatus(out.join('\n'), missing ? 2 : 0);
  },

  _cmd_nmcli(args) {
    const words = args.filter((arg) => !arg.startsWith('-'));
    const object = words[0] || 'general';
    if (/^d(e(v(i(c(e)?)?)?)?)?$/.test(object)) {
      return ok(
        table(
          [
            ['DEVICE', 'TYPE', 'STATE', 'CONNECTION'],
            ['eth0', 'ethernet', 'connected', 'eth0'],
            ['lo', 'loopback', 'connected (externally)', 'lo'],
          ],
          { trim: false }
        )
      );
    }
    if (/^c(o(n(n(e(c(t(i(o(n)?)?)?)?)?)?)?)?)?$/.test(object)) {
      if (
        words[1] &&
        /^(mod|modify|up|down|add|delete|del)/.test(words[1]) &&
        this._user() !== 'root'
      ) {
        return fail('Error: Failed to modify connection: Insufficient privileges.', 1);
      }
      return ok(
        table(
          [
            ['NAME', 'UUID', 'TYPE', 'DEVICE'],
            ['eth0', '9c92fad9-6ecb-3e6c-eb4d-8a47c6f50c04', 'ethernet', 'eth0'],
            ['lo', '0a4c1c3e-5e7f-4f2b-9b6e-2d5f8a1c3b7d', 'loopback', 'lo'],
          ],
          { trim: false }
        )
      );
    }
    return ok(
      table(
        [
          ['STATE', 'CONNECTIVITY', 'WIFI-HW', 'WIFI', 'WWAN-HW', 'WWAN'],
          ['connected', 'full', 'missing', 'enabled', 'missing', 'enabled'],
        ],
        { trim: false }
      )
    );
  },

  // ── firewalld ────────────────────────────────────────────────────────────

  ['_cmd_firewall-cmd'](args) {
    const host = this.host;
    let permanent = false;
    let zone = null;
    const operations = [];
    for (const arg of args) {
      if (arg === '--permanent') permanent = true;
      else if (arg.startsWith('--zone=')) zone = arg.slice(7);
      else if (arg === '-q' || arg === '--quiet') continue;
      else operations.push(arg);
    }
    if (!operations.length) {
      return fail('usage: see firewall-cmd man page\nNo option specified.', 2);
    }
    if (!host.firewall.running && !operations.includes('--state') && !permanent)
      return fail('FirewallD is not running', 252);
    const root = this._user() === 'root';
    const denied = () =>
      fail(
        'Authorization failed.\n    Make sure polkit agent is running or run the application as superuser.',
        253
      );
    if (zone && !host.firewallZones.includes(zone))
      return fail(`Error: INVALID_ZONE: ${zone}`, 112);
    const out = [];
    const warnings = [];
    let changed = false;
    let exitCode = 0;
    for (const op of operations) {
      const [option, value] = op.includes('=')
        ? [op.slice(0, op.indexOf('=')), op.slice(op.indexOf('=') + 1)]
        : [op, null];
      switch (option) {
        case '--state':
          if (!host.firewall.running) return fail('not running', 252);
          out.push('running');
          break;
        case '--get-default-zone':
          out.push(host.firewall.defaultZone);
          break;
        case '--set-default-zone':
          if (!root) return denied();
          if (!host.firewallZones.includes(value))
            return fail(`Error: INVALID_ZONE: ${value}`, 112);
          host.firewall.defaultZone = value;
          changed = true;
          break;
        case '--get-zones':
          out.push(host.firewallZones.join(' '));
          break;
        case '--get-active-zones':
          out.push(`${host.firewall.defaultZone}\n  interfaces: eth0`);
          break;
        case '--get-services':
          out.push(Object.keys(FIREWALL_SERVICES).sort().join(' '));
          break;
        case '--list-all': {
          const info = host.firewallZoneInfo(zone, { permanent });
          out.push(
            [
              `${info.name}${info.active ? ' (active)' : ''}`,
              '  target: default',
              '  icmp-block-inversion: no',
              `  interfaces: ${info.interfaces.join(' ')}`,
              '  sources: ',
              `  services: ${info.services.join(' ')}`,
              `  ports: ${info.ports.join(' ')}`,
              '  protocols: ',
              '  forward: yes',
              '  masquerade: no',
              '  forward-ports: ',
              '  source-ports: ',
              '  icmp-blocks: ',
              '  rich rules: ',
            ].join('\n')
          );
          break;
        }
        case '--list-services':
          out.push(host.firewallZoneInfo(zone, { permanent }).services.join(' '));
          break;
        case '--list-ports':
          out.push(host.firewallZoneInfo(zone, { permanent }).ports.join(' '));
          break;
        case '--info-service': {
          if (!FIREWALL_SERVICES[value]) return fail(`Error: INVALID_SERVICE: ${value}`, 101);
          out.push(
            [
              value,
              `  ports: ${FIREWALL_SERVICES[value].join(' ')}`,
              '  protocols: ',
              '  source-ports: ',
              '  modules: ',
              '  destination: ',
              '  includes: ',
              '  helpers: ',
            ].join('\n')
          );
          break;
        }
        case '--query-service':
        case '--query-port': {
          const has = host.firewallQuery(option === '--query-service' ? 'service' : 'port', value, {
            zone,
            permanent,
          });
          out.push(has ? 'yes' : 'no');
          if (!has) exitCode = 1;
          break;
        }
        case '--add-service':
        case '--remove-service':
        case '--add-port':
        case '--remove-port': {
          if (!root) return denied();
          const result = host.firewallChange(
            option.startsWith('--add') ? 'add' : 'remove',
            option.endsWith('service') ? 'service' : 'port',
            value,
            { zone, permanent }
          );
          if (result.error) return fail(`Error: ${result.error}`, result.code || 1);
          if (result.warning) warnings.push(`Warning: ${result.warning}`);
          changed = true;
          break;
        }
        case '--reload': {
          if (!root) return denied();
          const result = host.firewallReload();
          if (result.error) return fail(result.error, result.code || 252);
          changed = true;
          break;
        }
        case '--runtime-to-permanent':
          if (!root) return denied();
          host.firewallRuntimeToPermanent();
          changed = true;
          break;
        case '--complete-reload':
          if (!root) return denied();
          host.firewallReload();
          changed = true;
          break;
        default:
          return fail(
            `usage: see firewall-cmd man page\nfirewall-cmd: error: unrecognized arguments: ${op}`,
            2
          );
      }
    }
    if (changed) out.push('success');
    const message = [...warnings, ...out].join('\n');
    return exitCode ? withStatus(message, exitCode) : ok(message);
  },

  // ── packages ─────────────────────────────────────────────────────────────

  _dnfMetadataLine() {
    const host = this.host;
    const checked = host.resetAt - (23 * 60 + 41) * 1000;
    const age = Math.max(0, host.now() - checked);
    const h = Math.floor(age / 3600000);
    const m = Math.floor((age % 3600000) / 60000);
    const s = Math.floor((age % 60000) / 1000);
    return `Last metadata expiration check: ${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} ago on ${formatRpmTime(checked)}.`;
  },

  _cmd_yum(args, stdin) {
    return this._cmd_dnf(args, stdin);
  },

  _cmd_dnf(args) {
    const host = this.host;
    const { flags, longs, positionals } = parseArgs(args, {
      valueLong: ['repo', 'enablerepo', 'disablerepo'],
    });
    const assumeYes = flags.has('y') || longs.has('assumeyes');
    const quiet = flags.has('q');
    const [command = '', ...names] = positionals;
    const root = this._user() === 'root';
    const needRoot = () =>
      fail(
        'Error: This command has to be run with superuser privileges (under the root user on most systems).'
      );
    const meta = quiet ? [] : [this._dnfMetadataLine()];
    const sizeText = (kib) => (kib >= 1024 ? `${(kib / 1024).toFixed(1)} M` : `${kib} k`);
    switch (command) {
      case 'install':
      case 'in':
      case 'reinstall': {
        if (!root) return needRoot();
        if (!names.length)
          return fail('Error: Need to give at least one argument (package name or file path)');
        const missing = names.filter(
          (name) => !host.catalog.has(name.replace(/\.(x86_64|noarch)$/, ''))
        );
        if (missing.length) {
          return fail(
            [
              ...meta,
              ...missing.map((name) => `No match for argument: ${name}`),
              `Error: Unable to find a match: ${missing.join(' ')}`,
            ].join('\n')
          );
        }
        const wanted = names.map((name) => name.replace(/\.(x86_64|noarch)$/, ''));
        const already = wanted.filter((name) => host.isInstalled(name));
        const plan = host.resolveInstall(wanted);
        const out = [
          ...meta,
          ...already.map((name) => `Package ${host.nevra(name)} is already installed.`),
        ];
        if (!plan.length)
          return ok([...out, 'Dependencies resolved.', 'Nothing to do.', 'Complete!'].join('\n'));
        out.push('Dependencies resolved.', ...this._dnfTable(plan, 'Installing'));
        const download = plan.reduce(
          (sum, entry) => sum + host.catalog.get(entry.name).downloadKiB,
          0
        );
        const installed = plan.reduce(
          (sum, entry) => sum + host.catalog.get(entry.name).installKiB,
          0
        );
        out.push(
          '',
          'Transaction Summary',
          '='.repeat(80),
          `Install  ${plan.length} Package${plan.length === 1 ? '' : 's'}`,
          '',
          `Total download size: ${sizeText(download)}`,
          `Installed size: ${sizeText(installed)}`
        );
        if (!assumeYes)
          return fail(
            [
              ...out,
              'Is this ok [y/N]: Operation aborted.',
              '(simulator: the terminal cannot answer prompts — re-run with -y)',
            ].join('\n')
          );
        out.push('Downloading Packages:');
        plan.forEach((entry, index) => {
          const pkg = host.catalog.get(entry.name);
          const file = `(${index + 1}/${plan.length}): ${host.nevra(entry.name)}.rpm`;
          const rate = `${(2 + (fnv1a(entry.name) % 60) / 10).toFixed(1)} MB/s`;
          out.push(
            `${file.padEnd(49).slice(0, Math.max(49, file.length))} ${rate.padStart(10)} | ${sizeText(pkg.downloadKiB).replace(' ', ' ').padStart(6)}B     00:00    `.replace(
              /(\d) kB/,
              '$1 kB'
            )
          );
        });
        out.push(
          '-'.repeat(80),
          `Total${' '.repeat(43)}${'5.1 MB/s'.padStart(10)} | ${(download / 1024).toFixed(1)} MB     00:00     `
        );
        out.push(
          'Running transaction check',
          'Transaction check succeeded.',
          'Running transaction test',
          'Transaction test succeeded.',
          'Running transaction'
        );
        const counter = (index) => `${index}/${plan.length}`;
        out.push(`  Preparing        :${' '.repeat(52)}${'1/1'.padStart(8)} `);
        plan.forEach((entry, index) => {
          const pkg = host.catalog.get(entry.name);
          if (pkg.users.length)
            out.push(
              `  Running scriptlet: ${host.nevra(entry.name).padEnd(51)}${counter(index + 1).padStart(8)} `
            );
          out.push(
            `  Installing       : ${host.nevra(entry.name).padEnd(51)}${counter(index + 1).padStart(8)} `
          );
          if (pkg.units.length)
            out.push(
              `  Running scriptlet: ${host.nevra(entry.name).padEnd(51)}${counter(index + 1).padStart(8)} `
            );
        });
        plan.forEach((entry, index) =>
          out.push(
            `  Verifying        : ${host.nevra(entry.name).padEnd(51)}${counter(index + 1).padStart(8)} `
          )
        );
        host.installPackages(wanted);
        out.push(
          'Installed products updated.',
          '',
          'Installed:',
          ...columns(plan.map((entry) => host.nevra(entry.name))),
          '',
          'Complete!'
        );
        return ok(out.join('\n'));
      }
      case 'remove':
      case 'erase':
      case 'rm': {
        if (!root) return needRoot();
        const present = names.filter((name) => host.isInstalled(name));
        const absent = names.filter((name) => !host.isInstalled(name));
        const out = [...absent.map((name) => `No match for argument: ${name}`)];
        if (!present.length)
          return ok(
            [
              ...out,
              'No packages marked for removal.',
              'Dependencies resolved.',
              'Nothing to do.',
              'Complete!',
            ].join('\n')
          );
        out.push(
          'Dependencies resolved.',
          ...this._dnfTable(
            present.map((name) => ({ name, reason: 'user' })),
            'Removing',
            { installed: true }
          )
        );
        const freed = present.reduce((sum, name) => sum + host.catalog.get(name).installKiB, 0);
        out.push(
          '',
          'Transaction Summary',
          '='.repeat(80),
          `Remove  ${present.length} Package${present.length === 1 ? '' : 's'}`,
          '',
          `Freed space: ${sizeText(freed)}`
        );
        if (!assumeYes)
          return fail(
            [
              ...out,
              'Is this ok [y/N]: Operation aborted.',
              '(simulator: the terminal cannot answer prompts — re-run with -y)',
            ].join('\n')
          );
        out.push(
          'Running transaction check',
          'Transaction check succeeded.',
          'Running transaction test',
          'Transaction test succeeded.',
          'Running transaction'
        );
        out.push(`  Preparing        :${' '.repeat(52)}${'1/1'.padStart(8)} `);
        present.forEach((name, index) =>
          out.push(
            `  Erasing          : ${host.nevra(name).padEnd(51)}${`${index + 1}/${present.length}`.padStart(8)} `
          )
        );
        present.forEach((name, index) =>
          out.push(
            `  Verifying        : ${host.nevra(name).padEnd(51)}${`${index + 1}/${present.length}`.padStart(8)} `
          )
        );
        host.removePackages(present);
        out.push(
          'Installed products updated.',
          '',
          'Removed:',
          ...columns(present.map((name) => host.nevra(name))),
          '',
          'Complete!'
        );
        return ok(out.join('\n'));
      }
      case 'list': {
        let mode = 'all';
        let patterns = names;
        if (['installed', 'available', 'all', 'updates', 'upgrades'].includes(names[0])) {
          mode = names[0];
          patterns = names.slice(1);
        }
        if (longs.has('installed')) mode = 'installed';
        if (longs.has('available')) mode = 'available';
        const match = (name) =>
          !patterns.length || patterns.some((pattern) => globMatch(pattern, name));
        const installed = [...host.catalog.values()].filter(
          (pkg) => host.isInstalled(pkg.name) && match(pkg.name)
        );
        const available = [...host.catalog.values()].filter(
          (pkg) => !host.isInstalled(pkg.name) && match(pkg.name)
        );
        const row = (pkg, repo) =>
          `${`${pkg.name}.${pkg.arch}`.padEnd(39)} ${host.evr(pkg.name).padEnd(23)} ${repo}`;
        const out = [...meta];
        if ((mode === 'all' || mode === 'installed') && installed.length) {
          out.push(
            'Installed Packages',
            ...installed
              .sort((a, b) => collateNames(a.name, b.name))
              .map((pkg) =>
                row(
                  pkg,
                  `@${host.installed.get(pkg.name)?.repo === 'anaconda' ? 'anaconda' : REPOS[pkg.repo].id}`
                )
              )
          );
        }
        if ((mode === 'all' || mode === 'available') && available.length) {
          out.push(
            'Available Packages',
            ...available
              .sort((a, b) => collateNames(a.name, b.name))
              .map((pkg) => row(pkg, REPOS[pkg.repo].id))
          );
        }
        if (out.length === meta.length)
          return fail([...out, 'Error: No matching Packages to list'].join('\n'));
        return ok(out.join('\n'));
      }
      case 'info': {
        const out = [...meta];
        const missing = [];
        for (const sections of [
          ['Installed Packages', true],
          ['Available Packages', false],
        ]) {
          const pkgs = names
            .map((name) => host.catalog.get(name))
            .filter((pkg) => pkg && host.isInstalled(pkg.name) === sections[1]);
          if (!pkgs.length) continue;
          out.push(sections[0]);
          for (const pkg of pkgs) {
            const installedEntry = host.installed.get(pkg.name);
            const fields = [
              ['Name', pkg.name],
              ...(pkg.epoch ? [['Epoch', pkg.epoch]] : []),
              ['Version', pkg.version],
              ['Release', pkg.release],
              ['Architecture', pkg.arch],
              ['Size', sizeText(sections[1] ? pkg.installKiB : pkg.downloadKiB)],
              [
                'Source',
                `${pkg.name.replace(/-(core|filesystem|bdb|openssl)$/, '')}-${pkg.version}-${pkg.release}.src.rpm`,
              ],
              ['Repository', sections[1] ? '@System' : REPOS[pkg.repo].id],
              ...(sections[1]
                ? [
                    [
                      'From repo',
                      installedEntry?.repo === 'anaconda' ? 'anaconda' : REPOS[pkg.repo].id,
                    ],
                  ]
                : []),
              ['Summary', pkg.summary],
              ['URL', pkg.url],
              ['License', pkg.license],
            ];
            for (const [key, value] of fields) out.push(`${key.padEnd(13)}: ${value}`);
            const description = String(pkg.description).split('\n');
            out.push(
              `${'Description'.padEnd(13)}: ${description[0]}`,
              ...description.slice(1).map((line) => `${' '.repeat(13)}: ${line}`),
              ''
            );
          }
        }
        for (const name of names) if (!host.catalog.has(name)) missing.push(name);
        if (out.length === meta.length)
          return fail([...out, 'Error: No matching Packages to list'].join('\n'));
        return ok(out.join('\n').replace(/\n$/, ''));
      }
      case 'search': {
        if (!names.length) return fail('Error: Need to give at least one argument to search for');
        const term = names.join(' ').toLowerCase();
        const nameExact = [...host.catalog.values()].filter((pkg) => pkg.name === term);
        const nameMatch = [...host.catalog.values()].filter(
          (pkg) => pkg.name !== term && pkg.name.includes(term)
        );
        const summaryMatch = [...host.catalog.values()].filter(
          (pkg) => !pkg.name.includes(term) && pkg.summary.toLowerCase().includes(term)
        );
        const banner = (label) => {
          const text = ` ${label}: ${names.join(' ')} `;
          const left = Math.floor((80 - text.length) / 2);
          return `${'='.repeat(Math.max(1, left))}${text}${'='.repeat(Math.max(1, 80 - left - text.length))}`;
        };
        const out = [...meta];
        const line = (pkg) => `${pkg.name}.${pkg.arch} : ${pkg.summary}`;
        if (nameExact.length) out.push(banner('Name Exactly Matched'), ...nameExact.map(line));
        if (nameMatch.length) out.push(banner('Name Matched'), ...nameMatch.map(line));
        if (summaryMatch.length) out.push(banner('Summary Matched'), ...summaryMatch.map(line));
        if (out.length === meta.length) return fail([...out, `No matches found.`].join('\n'));
        return ok(out.join('\n'));
      }
      case 'provides':
      case 'whatprovides': {
        const target = names[0] || '';
        const out = [...meta];
        for (const pkg of host.catalog.values()) {
          const files = packageFiles(pkg);
          const hit = files.find(
            (file) =>
              file === target ||
              globMatch(target, file) ||
              file.endsWith(`/${target.replace(/^\*\//, '')}`)
          );
          if (hit)
            out.push(
              `${host.nevra(pkg.name)} : ${pkg.summary}`,
              `Repo        : ${host.isInstalled(pkg.name) ? '@System' : REPOS[pkg.repo].id}`,
              'Matched from:',
              `Filename    : ${hit}`,
              ''
            );
        }
        if (out.length === meta.length)
          return fail(
            [
              ...out,
              `Error: No matches found. If searching for a file, try specifying the full path or using a wildcard prefix ("*/") at the beginning.`,
            ].join('\n')
          );
        return ok(out.join('\n').replace(/\n$/, ''));
      }
      case 'repolist':
        return ok(
          table(
            [['repo id', 'repo name'], ...Object.values(REPOS).map((repo) => [repo.id, repo.name])],
            { gap: '  ' }
          )
        );
      case 'history':
        return ok(
          [
            'ID     | Command line                                       | Date and time    | Action(s)      | Altered',
            '-'.repeat(103),
            ...(host.dnfHistory || [])
              .map(
                (entry, index, list) =>
                  `${String(list.length - index + 1).padStart(6)} | ${`${entry.action.toLowerCase()} ${entry.names.join(' ')}`.padEnd(50).slice(0, 50)} | ${new Date(entry.time).toISOString().slice(0, 16).replace('T', ' ')} | ${entry.action.padEnd(14)} | ${String(entry.names.length).padStart(7)}`
              )
              .reverse(),
            `     1 |                                                    | ${new Date(host.installTime).toISOString().slice(0, 16).replace('T', ' ')} | Install        |  412 EE`,
          ].join('\n')
        );
      case 'check-update':
      case 'upgrade':
      case 'update':
        if ((command === 'upgrade' || command === 'update') && !root) return needRoot();
        return ok(
          [
            ...meta,
            ...(command === 'check-update'
              ? []
              : ['Dependencies resolved.', 'Nothing to do.', 'Complete!']),
          ].join('\n')
        );
      case 'clean':
        return ok(root ? '43 files removed' : '0 files removed');
      case 'makecache':
        return ok([...meta, 'Metadata cache created.'].join('\n'));
      case '':
        return fail(
          'usage: dnf [options] COMMAND\n\nList of Main Commands:\n\nautoremove                remove all unneeded packages that were originally installed as dependencies\ncheck-update              check for available package upgrades\nclean                     remove cached data\ndowngrade                 Downgrade a package\ninfo                      display details about a package or group of packages\ninstall                   install a package or packages on your system\nlist                      list a package or groups of packages\nmakecache                 generate the metadata cache\nprovides                  find what package provides the given value\nreinstall                 reinstall a package\nremove                    remove a package or packages from your system\nrepolist                  display the configured software repositories\nsearch                    search package details for the given string\nupgrade                   upgrade a package or packages on your system',
          1
        );
      default:
        return fail(
          `No such command: ${command}. Please use /usr/bin/dnf --help\nIt could be a DNF plugin command, try: "dnf install 'dnf-command(${command})'"`
        );
    }
  },

  /** The dnf transaction table (80 columns, long repo ids wrap the size). */
  _dnfTable(plan, verb, { installed = false } = {}) {
    const host = this.host;
    const rows = plan.map((entry) => {
      const pkg = host.catalog.get(entry.name);
      return {
        reason: entry.reason,
        cells: [
          pkg.name,
          pkg.arch,
          host.evr(pkg.name),
          installed ? `@${REPOS[pkg.repo].id}` : REPOS[pkg.repo].id,
        ],
        size: installed
          ? `${pkg.installKiB >= 1024 ? `${(pkg.installKiB / 1024).toFixed(1)} M` : `${pkg.installKiB} k`}`
          : `${pkg.downloadKiB >= 1024 ? `${(pkg.downloadKiB / 1024).toFixed(1)} M` : `${pkg.downloadKiB} k`}`,
      };
    });
    const widths = [
      Math.max(7, ...rows.map((row) => row.cells[0].length)),
      Math.max(12, ...rows.map((row) => row.cells[1].length)),
      Math.max(7, ...rows.map((row) => row.cells[2].length)),
    ];
    const line = (cells, size) => {
      const text = ` ${cells[0].padEnd(widths[0])} ${cells[1].padEnd(widths[1])} ${cells[2].padEnd(widths[2])} ${cells[3]}`;
      if (text.length + 1 + size.length <= 80)
        return [`${text}${' '.repeat(80 - text.length - size.length)}${size}`];
      return [text, size.padStart(80)];
    };
    const out = [
      '='.repeat(80),
      ...line(['Package', 'Architecture', 'Version', 'Repository'], 'Size'),
      '='.repeat(80),
    ];
    const groups = [
      [`${verb}:`, rows.filter((row) => row.reason === 'user')],
      [`${verb} dependencies:`, rows.filter((row) => row.reason !== 'user')],
    ];
    for (const [label, groupRows] of groups) {
      if (!groupRows.length) continue;
      out.push(label);
      for (const row of groupRows) out.push(...line(row.cells, row.size));
    }
    return out;
  },

  _cmd_rpm(args) {
    const host = this.host;
    const { flags, longs, positionals } = parseArgs(args);
    const query = flags.has('q') || longs.has('query');
    if (!query) {
      if (
        flags.has('i') ||
        flags.has('U') ||
        flags.has('e') ||
        longs.has('install') ||
        longs.has('erase')
      ) {
        if (this._user() !== 'root')
          return fail(
            "error: can't create transaction lock on /var/lib/rpm/.rpm.lock (Permission denied)"
          );
        if (flags.has('e')) {
          const missing = positionals.filter((name) => !host.isInstalled(name));
          if (missing.length)
            return fail(
              missing.map((name) => `error: package ${name} is not installed`).join('\n')
            );
          host.removePackages(positionals);
          return ok('');
        }
        return fail(`error: open of ${positionals[0] || ''} failed: No such file or directory`);
      }
      return fail(
        'RPM version 4.16.1.3\nCopyright (C) 1998-2002 - Red Hat, Inc.\nThis program may be freely redistributed under the terms of the GNU GPL\n\nUsage: rpm [-afgpcdLAlsiv?] [-a|--all] [-f|--file] [-q|--query] [OPTION...]',
        1
      );
    }
    if (flags.has('a') || longs.has('all')) {
      const pattern = positionals[0];
      const list = [...host.installed.keys()]
        .filter((name) => !pattern || globMatch(pattern, name) || name.includes(pattern))
        .map((name) => host.nevra(name));
      return ok(list.join('\n'));
    }
    if (flags.has('f') || longs.has('file')) {
      const out = [];
      let failures = 0;
      for (const path of positionals) {
        const found = host.stat(path, { user: 'root', follow: false });
        if (!found.ok) {
          out.push(`error: file ${host.resolvePath(path)}: No such file or directory`);
          failures += 1;
          continue;
        }
        const owner = [...host.catalog.values()].find(
          (pkg) => host.isInstalled(pkg.name) && packageFiles(pkg).includes(found.path)
        );
        if (owner) out.push(host.nevra(owner.name));
        else {
          out.push(`file ${found.path} is not owned by any package`);
          failures += 1;
        }
      }
      return failures
        ? { error: true, message: out.join('\n'), exitCode: failures }
        : ok(out.join('\n'));
    }
    if (!positionals.length) return fail('rpm: no arguments given for query');
    const out = [];
    let failures = 0;
    for (const name of positionals) {
      if (!host.isInstalled(name)) {
        out.push(`package ${name} is not installed`);
        failures += 1;
        continue;
      }
      const pkg = host.catalog.get(name);
      if (flags.has('i')) {
        const installedEntry = host.installed.get(name);
        out.push(
          `Name        : ${pkg.name}`,
          ...(pkg.epoch ? [`Epoch       : ${pkg.epoch}`] : []),
          `Version     : ${pkg.version}`,
          `Release     : ${pkg.release}`,
          `Architecture: ${pkg.arch}`,
          `Install Date: ${formatRpmTime(installedEntry?.time ?? host.installTime)}`,
          'Group       : Unspecified',
          `Size        : ${pkg.installKiB * 1024}`,
          `License     : ${pkg.license}`,
          `Signature   : RSA/SHA256, ${formatRpmTime(host.installTime - 86400000 * 30)}, Key ID 199e2f91fd431d51`,
          `Source RPM  : ${pkg.name}-${pkg.version}-${pkg.release}.src.rpm`,
          `Build Date  : ${formatRpmTime(host.installTime - 86400000 * 32)}`,
          'Build Host  : x86-64-02.build.eng.rdu2.redhat.com',
          'Packager    : Red Hat, Inc. <http://bugzilla.redhat.com/bugzilla>',
          'Vendor      : Red Hat, Inc.',
          `URL         : ${pkg.url}`,
          `Summary     : ${pkg.summary}`,
          'Description :',
          pkg.description
        );
        continue;
      }
      if (flags.has('l') || flags.has('c') || flags.has('d')) {
        let files = packageFiles(pkg);
        if (flags.has('c'))
          files = files.filter(
            (file) => file.startsWith('/etc/') && !host._lookup(file)?.type?.startsWith('d')
          );
        if (flags.has('d')) files = [`/usr/share/doc/${pkg.name}`];
        out.push(...(files.length ? files : ['(contains no files)']));
        continue;
      }
      out.push(host.nevra(name));
    }
    return failures
      ? { error: true, message: out.join('\n'), exitCode: failures }
      : ok(out.join('\n'));
  },

  // ── rootless podman ──────────────────────────────────────────────────────

  _cmd_podman(args, stdin) {
    const host = this.host;
    const user = this._user();
    let index = 0;
    while (
      index < args.length &&
      args[index].startsWith('-') &&
      args[index] !== '--version' &&
      args[index] !== '-v'
    )
      index += 1;
    const sub = args[index] || '';
    const rest = args.slice(index + 1);
    const aliases = { ps: 'ps', ls: 'ps', images: 'images', rmi: 'rmi' };
    if (sub === '--version' || sub === '-v' || sub === 'version')
      return ok(
        sub === 'version'
          ? `Client:       Podman Engine\nVersion:      ${PODMAN_VERSION}\nAPI Version:  ${PODMAN_VERSION}\nGo Version:   go1.23.6 (Red Hat 1.23.6-1.el9_6)\nBuilt:        Thu Apr 24 08:11:21 2025\nOS/Arch:      linux/amd64`
          : `podman version ${PODMAN_VERSION}`
      );
    if (sub === 'container' || sub === 'image') {
      const [inner, ...innerRest] = rest;
      const map =
        sub === 'container'
          ? {
              ls: 'ps',
              list: 'ps',
              rm: 'rm',
              inspect: 'inspect',
              logs: 'logs',
              stop: 'stop',
              start: 'start',
              run: 'run',
              exec: 'exec',
              prune: 'container-prune',
              restart: 'restart',
              port: 'port',
            }
          : {
              ls: 'images',
              list: 'images',
              rm: 'rmi',
              pull: 'pull',
              inspect: 'image-inspect',
              tag: 'tag',
              prune: 'image-prune',
            };
      if (!map[inner])
        return fail(
          `Error: unrecognized command \`podman ${sub} ${inner || ''}\`\nTry 'podman ${sub} --help' for more information`,
          125
        );
      return this._podman(map[inner], innerRest, stdin, user);
    }
    if (!sub)
      return fail(
        "Error: missing command 'podman COMMAND'\nTry 'podman --help' for more information.",
        125
      );
    return this._podman(aliases[sub] || sub, rest, stdin, user);
  },

  _podman(sub, args, stdin, user) {
    const host = this.host;
    const now = host.now();
    const noSuchContainer = (name) =>
      fail(`Error: no container with name or ID "${name}" found: no such container`, 125);
    const shortId = (id) => id.slice(0, 12);
    switch (sub) {
      case 'pull': {
        const ref = args.find((arg) => !arg.startsWith('-'));
        if (!ref) return fail('Error: requires exactly 1 arg(s), only received 0', 125);
        const quiet = args.includes('-q') || args.includes('--quiet');
        return this._podmanPull(ref, user, { quiet });
      }
      case 'images': {
        const { flags, longs } = parseArgs(args, { valueLong: ['format', 'filter'] });
        const store = host.podman[user === 'root' ? 'root' : 'student'];
        const rows = [];
        for (const image of store.images.values()) {
          for (const name of image.names) {
            const slash = name.lastIndexOf(':');
            rows.push({ repo: name.slice(0, slash), tag: name.slice(slash + 1), image });
          }
        }
        rows.sort((a, b) => Date.parse(b.image.created) - Date.parse(a.image.created));
        if (flags.has('q'))
          return ok([...new Set(rows.map((row) => shortId(row.image.id)))].join('\n'));
        if (longs.has('format')) {
          return ok(
            rows
              .map((row) =>
                goTemplate(String(longs.get('format')), {
                  Repository: row.repo,
                  Tag: row.tag,
                  ID: shortId(row.image.id),
                  Id: row.image.id,
                  Digest: row.image.digest,
                  Size: `${row.image.entry.sizeMB} MB`,
                  Created: row.image.created,
                })
              )
              .join('\n')
          );
        }
        const digests = longs.has('digests');
        const header = [
          'REPOSITORY',
          'TAG',
          ...(digests ? ['DIGEST'] : []),
          'IMAGE ID',
          'CREATED',
          'SIZE',
        ];
        const body = rows.map((row) => [
          row.repo,
          row.tag,
          ...(digests ? [row.image.digest] : []),
          shortId(row.image.id),
          `${humanDuration(now - Date.parse(row.image.created))} ago`,
          `${row.image.entry.sizeMB} MB`,
        ]);
        return ok(table([header, ...body], { gap: '  ' }));
      }
      case 'run':
      case 'create':
        return this._podmanRun(sub, args, stdin, user);
      case 'ps': {
        const { flags, longs } = parseArgs(args, { valueLong: ['format', 'filter'] });
        const all = flags.has('a') || longs.has('all');
        const containers = host.listContainers({ user, all });
        if (flags.has('q'))
          return ok(containers.map((container) => shortId(container.id)).join('\n'));
        if (longs.has('format')) {
          return ok(
            containers
              .map((container) =>
                goTemplate(String(longs.get('format')), {
                  ID: shortId(container.id),
                  Names: container.name,
                  Image: container.imageRef,
                  Status: this._podmanStatus(container),
                  Ports: this._podmanPorts(container),
                  State: container.state,
                  Command: container.command.join(' '),
                })
              )
              .join('\n')
          );
        }
        const header = ['CONTAINER ID', 'IMAGE', 'COMMAND', 'CREATED', 'STATUS', 'PORTS', 'NAMES'];
        const body = containers.map((container) => {
          const command = container.command.join(' ');
          return [
            shortId(container.id),
            container.imageRef,
            command.length > 20 ? `${command.slice(0, 17)}...` : command,
            `${humanDuration(now - container.created)} ago`,
            this._podmanStatus(container),
            this._podmanPorts(container),
            container.name,
          ];
        });
        return ok(table([header, ...body], { gap: '  ' }));
      }
      case 'logs': {
        const { flags, values, longs, positionals } = parseArgs(args, {
          valueShort: 'n',
          valueLong: ['tail', 'since'],
        });
        const name = positionals[0];
        if (!name) return fail('Error: requires at least 1 arg(s), only received 0', 125);
        const container = host.findContainer(name, { user });
        if (!container) return noSuchContainer(name);
        let logs = [...container.logs];
        const tail = values.get('n') ?? longs.get('tail');
        if (tail !== undefined) logs = logs.slice(-Number(tail));
        void flags;
        return ok(logs.join('\n'));
      }
      case 'stop':
      case 'kill': {
        const names = args.filter((arg) => !arg.startsWith('-'));
        if (args.includes('-a') || args.includes('--all'))
          names.push(...host.listContainers({ user }).map((container) => container.name));
        if (!names.length) return fail('Error: you must provide at least one name or id', 125);
        const out = [];
        const warnings = [];
        for (const name of names) {
          const container = host.findContainer(name, { user });
          if (!container) return noSuchContainer(name);
          const stopped = host.stopContainer(container);
          if (sub === 'stop' && stopped.killed)
            warnings.push(
              `WARN[0010] StopSignal SIGTERM failed to stop container ${container.name} in 10 seconds, resorting to SIGKILL`
            );
          out.push(name);
        }
        return ok([...warnings, ...out].join('\n'));
      }
      case 'start':
      case 'restart': {
        const names = args.filter((arg) => !arg.startsWith('-'));
        const out = [];
        for (const name of names) {
          const container = host.findContainer(name, { user });
          if (!container) return noSuchContainer(name);
          if (sub === 'restart') host.stopContainer(container);
          const started = host.startContainer(container);
          if (started.error) return this._podmanPublishFailure(started);
          out.push(name);
        }
        return ok(out.join('\n'));
      }
      case 'rm': {
        const { flags, longs, positionals } = parseArgs(args);
        const force = flags.has('f') || longs.has('force');
        const names = [...positionals];
        if (flags.has('a') || longs.has('all'))
          names.push(
            ...host.listContainers({ user, all: true }).map((container) => container.name)
          );
        if (!names.length) return fail('Error: must specify at least one container', 125);
        const out = [];
        for (const name of names) {
          const container = host.findContainer(name, { user });
          if (!container) {
            if (force) continue;
            return noSuchContainer(name);
          }
          const removed = host.removeContainer(container, { user, force });
          if (removed.error === 'running') {
            return fail(
              `Error: cannot remove container ${container.id} as it is running - running or paused containers cannot be removed without force: container state improper`,
              2
            );
          }
          out.push(name);
        }
        return ok(out.join('\n'));
      }
      case 'rmi': {
        const { flags, positionals } = parseArgs(args);
        const out = [];
        for (const name of positionals) {
          const removed = host.removeImage(name, { user, force: flags.has('f') });
          if (removed.error === 'not-found') return fail(`Error: ${name}: image not known`, 1);
          if (removed.error === 'in-use')
            return fail(
              `Error: image used by ${removed.container.id}: image is in use by a container: consider listing external containers and force-removing image`,
              2
            );
          out.push(
            ...removed.untagged.map((tag) => `Untagged: ${tag}`),
            `Deleted: ${removed.image.id}`
          );
        }
        return ok(out.join('\n'));
      }
      case 'tag': {
        const [source, ...targets] = args.filter((arg) => !arg.startsWith('-'));
        if (!source || !targets.length)
          return fail('Error: at least two arguments are required', 125);
        for (const target of targets) {
          const tagged = host.tagImage(source, target, { user });
          if (tagged.error) return fail(`Error: ${source}: image not known`, 125);
        }
        return ok('');
      }
      case 'exec':
        return this._podmanExec(args, stdin, user);
      case 'port': {
        const name = args.find((arg) => !arg.startsWith('-'));
        const container = host.findContainer(name, { user });
        if (!container) return noSuchContainer(name);
        return ok(
          container.ports
            .map(
              (port) =>
                `${port.containerPort}/${port.proto} -> ${port.hostIp || '0.0.0.0'}:${port.hostPort}`
            )
            .join('\n')
        );
      }
      case 'inspect':
      case 'image-inspect': {
        const { values, longs, positionals } = parseArgs(args, {
          valueShort: 'f',
          valueLong: ['format', 'type'],
        });
        const format = values.get('f') ?? longs.get('format');
        const results = [];
        for (const name of positionals) {
          const container = sub === 'inspect' ? host.findContainer(name, { user }) : null;
          const image = container ? null : host.findImage(name, { user });
          if (!container && !image) return fail(`Error: no such object: "${name}"`, 125);
          results.push(container ? this._containerInspect(container) : this._imageInspect(image));
        }
        if (format) return ok(results.map((data) => goTemplate(String(format), data)).join('\n'));
        return ok(
          JSON.stringify(results, null, 5).replace(/^( +)/gm, (match) =>
            '     '.repeat(match.length / 5)
          )
        );
      }
      case 'search':
        return ok(
          table(
            [
              ['NAME', 'DESCRIPTION'],
              ...[...host.registry.values()]
                .filter((entry) =>
                  entry.repo.includes(args.find((arg) => !arg.startsWith('-')) || '')
                )
                .map((entry) => [entry.repo, entry.summary]),
            ],
            { gap: '  ' }
          )
        );
      case 'login': {
        const registry = args.find((arg) => !arg.startsWith('-'));
        if (!registry) return fail('Error: please provide a registry to log in to', 125);
        return ok('Login Succeeded!');
      }
      case 'logout':
        return ok(
          `Removed login credentials for ${args.find((arg) => !arg.startsWith('-')) || 'registry'}`
        );
      case 'info':
        return ok(
          `host:\n  arch: amd64\n  buildahVersion: 1.39.4\n  cgroupManager: systemd\n  cgroupVersion: v2\n  hostname: ${host.hostname}\n  kernel: ${KERNEL_RELEASE}\n  networkBackend: netavark\n  os: linux\n  rootlessNetworkCmd: pasta\n  security:\n    rootless: ${user !== 'root'}\n    selinuxEnabled: true\nstore:\n  graphDriverName: overlay\n  graphRoot: ${user === 'root' ? '/var/lib/containers/storage' : '/home/student/.local/share/containers/storage'}\nversion:\n  APIVersion: ${PODMAN_VERSION}\n  Version: ${PODMAN_VERSION}`
        );
      default:
        return fail(
          `Error: unrecognized command \`podman ${sub}\`\nTry 'podman --help' for more information`,
          125
        );
    }
  },

  _podmanStatus(container) {
    const now = this.host.now();
    if (container.state === 'running')
      return `Up ${humanDuration(now - (container.startedAt || now))}`;
    if (container.state === 'created') return 'Created';
    return `Exited (${container.exitCode}) ${humanDuration(now - (container.finishedAt || now))} ago`;
  },

  _podmanPorts(container) {
    const published = container.ports.map(
      (port) => `${port.hostIp || '0.0.0.0'}:${port.hostPort}->${port.containerPort}/${port.proto}`
    );
    const exposed = (container.image.entry.exposes || [])
      .filter((port) => !container.ports.some((entry) => entry.containerPort === port))
      .map((port) => `${port}/tcp`);
    return [...published, ...exposed].join(', ');
  },

  _podmanPullLines(resolved, image, existed) {
    const lines = [];
    if (resolved.alias)
      lines.push(
        `Resolved "${resolved.repo.split('/').slice(1).join('/')}" as an alias (/etc/containers/registries.conf.d/001-rhel-shortnames.conf)`
      );
    lines.push(
      `Trying to pull ${resolved.ref}...`,
      'Getting image source signatures',
      'Checking if image destination supports signatures'
    );
    const blobs = [fakeSha256(`blob-a-${resolved.repo}`), fakeSha256(`blob-b-${resolved.repo}`)];
    for (const blob of blobs)
      lines.push(
        `Copying blob ${blob.slice(0, 12)} ${existed ? 'skipped: already exists  ' : 'done   | '}`
      );
    lines.push(
      `Copying config ${image.id.slice(0, 12)} done   | `,
      'Writing manifest to image destination',
      'Storing signatures'
    );
    return lines;
  },

  _podmanPull(ref, user, { quiet = false } = {}) {
    const host = this.host;
    const pulled = host.pullImage(ref, { user });
    if (pulled.error === 'short-name')
      return fail('Error: short-name resolution enforced but cannot prompt without a TTY', 125);
    if (pulled.error === 'no-such-host') {
      return fail(
        `Trying to pull ${pulled.resolved.ref}...\nError: initializing source docker://${pulled.resolved.ref}: pinging container registry ${pulled.resolved.registryHost}: Get "https://${pulled.resolved.registryHost}/v2/": dial tcp: lookup ${pulled.resolved.registryHost}: no such host`,
        125
      );
    }
    if (pulled.error === 'repo-not-found') {
      return fail(
        `Trying to pull ${pulled.resolved.ref}...\nError: initializing source docker://${pulled.resolved.ref}: reading manifest ${pulled.resolved.tag} in ${pulled.resolved.repo}: name unknown: Repo not found`,
        125
      );
    }
    if (pulled.error === 'manifest-unknown') {
      return fail(
        `Trying to pull ${pulled.resolved.ref}...\nError: initializing source docker://${pulled.resolved.ref}: reading manifest ${pulled.resolved.tag} in ${pulled.resolved.repo}: manifest unknown`,
        125
      );
    }
    if (pulled.error) return fail(`Error: ${pulled.error}`, 125);
    const lines = quiet ? [] : this._podmanPullLines(pulled.resolved, pulled.image, pulled.existed);
    lines.push(pulled.image.id);
    return ok(lines.join('\n'));
  },

  _podmanPublishFailure(result) {
    if (result.error === 'privileged-port') {
      const port = result.port;
      return fail(
        `Error: pasta failed with exit code 1:\nFailed to bind port ${port.hostPort} (Permission denied) for option '-t ${port.hostPort}-${port.hostPort}:${port.containerPort}-${port.containerPort}', exiting`,
        126
      );
    }
    if (result.error === 'port-in-use') {
      const port = result.port;
      return fail(
        `Error: pasta failed with exit code 1:\nFailed to bind port ${port.hostPort} (Address already in use) for option '-t ${port.hostPort}-${port.hostPort}:${port.containerPort}-${port.containerPort}', exiting`,
        126
      );
    }
    return fail(`Error: ${result.error}`, 125);
  },

  _podmanRun(sub, args, stdin, user) {
    const host = this.host;
    const options = { ports: [], env: {}, volumes: [] };
    let detach = false;
    let rm = false;
    let interactive = false;
    let replace = false;
    let index = 0;
    for (; index < args.length; index += 1) {
      const arg = args[index];
      if (!arg.startsWith('-')) break;
      const takeValue = () => (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++index]);
      if (arg === '-d' || arg === '--detach') detach = true;
      else if (arg === '--rm') rm = true;
      else if (arg === '--replace') replace = true;
      else if (/^-[it]+$/.test(arg) || arg === '--interactive' || arg === '--tty')
        interactive = true;
      else if (/^-[dit]+$/.test(arg)) {
        if (arg.includes('d')) detach = true;
        if (/[it]/.test(arg)) interactive = true;
      } else if (arg === '--name' || arg.startsWith('--name=')) options.name = takeValue();
      else if (arg === '-p' || arg === '--publish' || arg.startsWith('--publish='))
        options.ports.push(takeValue());
      else if (/^-p\d/.test(arg)) options.ports.push(arg.slice(2));
      else if (arg === '-e' || arg === '--env' || arg.startsWith('--env=')) {
        const pair = String(takeValue() ?? '');
        const eq = pair.indexOf('=');
        options.env[eq < 0 ? pair : pair.slice(0, eq)] = eq < 0 ? '' : pair.slice(eq + 1);
      } else if (arg === '-v' || arg === '--volume' || arg.startsWith('--volume='))
        options.volumes.push(takeValue());
      else if (
        [
          '--network',
          '--net',
          '--user',
          '-u',
          '--hostname',
          '-h',
          '--restart',
          '--memory',
          '-m',
          '--cpus',
          '-w',
          '--workdir',
          '--label',
          '-l',
          '--entrypoint',
        ].includes(arg.split('=')[0])
      )
        takeValue();
    }
    const ref = args[index];
    if (!ref) return fail('Error: requires at least 1 arg(s), only received 0', 125);
    const command = args.slice(index + 1);
    const out = [];
    let image = host.findImage(ref, { user });
    let resolvedRef = image
      ? image.names.find((name) => name === host.resolveImageRef(ref).ref) || image.names[0]
      : null;
    if (!image) {
      const pulled = this._podmanPull(ref, user);
      if (pulled.error) return pulled;
      out.push(...pulled.message.split('\n'));
      image = host.findImage(ref, { user });
      resolvedRef = host.resolveImageRef(ref).ref;
    }
    if (options.name) {
      const existing = host.findContainer(options.name, { user });
      if (existing) {
        if (!replace)
          return fail(
            `Error: creating container storage: the container name "${options.name}" is already in use by ${existing.id}. You have to remove that container to be able to reuse that name: that name is already in use, or use --replace to instruct Podman to do so.`,
            125
          );
        host.removeContainer(existing, { user, force: true });
      }
    }
    const created = host.createContainer(
      { ...options, image, imageRef: resolvedRef, command, rm },
      { user }
    );
    if (created.error === 'bad-publish')
      return fail(`Error: invalid containerPort: ${created.value}`, 125);
    if (created.error) return fail(`Error: ${created.error}`, 125);
    const container = created.container;
    if (sub === 'create') return ok([...out, container.id].join('\n'));
    if (interactive && !detach && !command.length) {
      host.removeContainer(container, { user, force: true });
      return fail(
        `${out.length ? `${out.join('\n')}\n` : ''}(simulator: interactive container shells are not supported — run it detached, e.g. podman run -d --name test ${ref} sleep infinity, then podman exec test <command>)`,
        1
      );
    }
    const started = host.startContainer(container);
    if (started.error) {
      host.removeContainer(container, { user, force: true });
      return this._podmanPublishFailure(started);
    }
    if (detach) return ok([...out, container.id].join('\n'));
    // Foreground: run the command (or the image's default) and report its output.
    if (command.length && !/^(sleep)$/.test(command[0])) {
      const result = this._containerCommand(container, command, stdin);
      host.stopContainer(container);
      container.exitCode = result.exitCode ?? 0;
      if (rm) host.removeContainer(container, { user, force: true });
      if (result.exitCode)
        return {
          error: true,
          message: [...out, result.message].filter(Boolean).join('\n'),
          exitCode: result.exitCode,
        };
      return ok([...out, result.message].filter(Boolean).join('\n'));
    }
    if (container.state === 'running') {
      return ok(
        [
          ...out,
          ...container.logs,
          '(simulator: the container keeps running in the foreground on a real system — use -d to detach)',
        ].join('\n')
      );
    }
    if (rm) host.removeContainer(container, { user, force: true });
    return withStatus([...out, ...container.logs].join('\n'), container.exitCode);
  },

  _podmanExec(args, stdin, user) {
    const host = this.host;
    let index = 0;
    while (index < args.length && args[index].startsWith('-')) {
      if (['-u', '--user', '-w', '--workdir', '-e', '--env'].includes(args[index])) index += 1;
      index += 1;
    }
    const name = args[index];
    const command = args.slice(index + 1);
    if (!name)
      return fail(
        'Error: must provide a non-empty command to start an exec session: invalid argument',
        125
      );
    const container = host.findContainer(name, { user });
    if (!container)
      return fail(`Error: no container with name or ID "${name}" found: no such container`, 125);
    if (container.state !== 'running')
      return fail(
        'Error: can only create exec sessions on running containers: container state improper',
        125
      );
    if (!command.length)
      return fail(
        'Error: must provide a non-empty command to start an exec session: invalid argument',
        125
      );
    return this._containerCommand(container, command, stdin);
  },

  /** A tiny in-container shell for `podman exec/run CMD` (cat, ls, id, env, …). */
  _containerCommand(container, command, stdin) {
    const host = this.host;
    let argv = [...command];
    if (
      (argv[0] === 'sh' ||
        argv[0] === 'bash' ||
        argv[0] === '/bin/sh' ||
        argv[0] === '/bin/bash') &&
      argv[1] === '-c'
    ) {
      argv = String(argv[2] || '')
        .trim()
        .split(/\s+/);
    }
    const [name, ...rest] = argv;
    const entry = container.image.entry;
    const uid = Number(entry.user || 0);
    const userName = uid === 0 ? 'root' : uid === 27 ? 'mysql' : 'default';
    switch (basenameOf(name || '')) {
      case 'cat': {
        const out = [];
        for (const file of rest) {
          const content = host.containerFile(
            container,
            file.startsWith('/') ? file : `${entry.workdir}/${file}`
          );
          if (content === null)
            return { error: true, message: `cat: ${file}: No such file or directory`, exitCode: 1 };
          out.push(content.replace(/\n$/, ''));
        }
        if (!rest.length) return ok(String(stdin ?? ''));
        return ok(out.join('\n'));
      }
      case 'ls': {
        const target = rest.find((arg) => !arg.startsWith('-')) || entry.workdir;
        const listing = host.containerDirectory(container, target);
        if (listing === null) {
          const file = host.containerFile(container, target);
          if (file !== null) return ok(target);
          return {
            error: true,
            message: `ls: cannot access '${target}': No such file or directory`,
            exitCode: 2,
          };
        }
        return ok(listing.join('\n'));
      }
      case 'echo':
        return ok(rest.join(' '));
      case 'id':
        return ok(
          rest.includes('-u') ? String(uid) : `uid=${uid}(${userName}) gid=0(root) groups=0(root)`
        );
      case 'whoami':
        return ok(userName);
      case 'hostname':
        return ok(container.hostname);
      case 'pwd':
        return ok(entry.workdir);
      case 'uname':
        return ok(
          rest.includes('-r')
            ? KERNEL_RELEASE
            : rest.includes('-a')
              ? `Linux ${container.hostname} ${KERNEL_RELEASE} ${KERNEL_VERSION} x86_64 x86_64 x86_64 GNU/Linux`
              : 'Linux'
        );
      case 'env':
      case 'printenv': {
        const env = [
          ...entry.env,
          `HOSTNAME=${container.hostname}`,
          'HOME=/root',
          ...Object.entries(container.env).map(([key, value]) => `${key}=${value}`),
        ];
        if (rest.length) {
          const values = rest.map((key) =>
            env
              .find((line) => line.startsWith(`${key}=`))
              ?.split('=')
              .slice(1)
              .join('=')
          );
          return values.some((value) => value === undefined)
            ? { error: true, message: '', exitCode: 1, silentFailure: true }
            : ok(values.join('\n'));
        }
        return ok(env.join('\n'));
      }
      case 'ps':
        return ok(
          `    PID TTY          TIME CMD\n      1 ?        00:00:00 ${(entry.comm || basenameOf(container.command[0] || 'sh')).slice(0, 15)}\n      ${10 + (fnv1a(container.id) % 80)} ?        00:00:00 ps`
        );
      case 'date':
        return ok(formatDate(host.now()));
      case 'sleep':
      case 'true':
        return ok('');
      case 'false':
        return { error: true, message: '', exitCode: 1, silentFailure: true };
      case 'curl': {
        const url = rest.find((arg) => !arg.startsWith('-')) || '';
        if (
          /localhost:8080|127\.0\.0\.1:8080/.test(url) &&
          (entry.serves === 'httpd' || entry.serves === 'nginx' || entry.serves === 'hello')
        ) {
          const response = host._serveContainerHttp(container, {
            path: url.replace(/^\w+:\/\/[^/]+/, '') || '/',
          });
          return ok(response.body.replace(/\n$/, ''));
        }
        return {
          error: true,
          message: `curl: (7) Failed to connect to ${url.replace(/^\w+:\/\//, '').split('/')[0]} port 80: Connection refused`,
          exitCode: 7,
        };
      }
      default:
        return {
          error: true,
          message: `Error: crun: executable file \`${name}\` not found in $PATH: No such file or directory: OCI runtime attempted to invoke a command that was not found`,
          exitCode: 127,
        };
    }
  },

  _containerInspect(container) {
    const entry = container.image.entry;
    const ports = {};
    for (const port of entry.exposes || []) ports[`${port}/tcp`] = null;
    for (const port of container.ports)
      ports[`${port.containerPort}/${port.proto}`] = [
        { HostIp: port.hostIp || '', HostPort: String(port.hostPort) },
      ];
    return {
      Id: container.id,
      Created: new Date(container.created).toISOString(),
      Path: container.command[0] || '',
      Args: container.command.slice(1),
      State: {
        OciVersion: '1.2.0',
        Status: container.state,
        Running: container.state === 'running',
        Paused: false,
        Restarting: false,
        OOMKilled: false,
        Dead: false,
        Pid: container.pid || 0,
        ExitCode: container.exitCode || 0,
        Error: '',
        StartedAt: container.startedAt
          ? new Date(container.startedAt).toISOString()
          : '0001-01-01T00:00:00Z',
        FinishedAt: container.finishedAt
          ? new Date(container.finishedAt).toISOString()
          : '0001-01-01T00:00:00Z',
      },
      Image: container.image.id,
      ImageDigest: container.image.digest,
      ImageName: container.imageRef,
      Name: container.name,
      RestartCount: 0,
      Driver: 'overlay',
      MountLabel: `system_u:object_r:container_file_t:s0:c${(fnv1a(container.id) % 900) + 100},c${(fnv1a(container.name) % 900) + 100}`,
      ProcessLabel: `system_u:system_r:container_t:s0:c${(fnv1a(container.id) % 900) + 100},c${(fnv1a(container.name) % 900) + 100}`,
      Config: {
        Hostname: container.hostname,
        User: entry.user,
        Env: [
          ...entry.env,
          ...Object.entries(container.env).map(([key, value]) => `${key}=${value}`),
        ],
        Cmd: container.command,
        Image: container.imageRef,
        WorkingDir: entry.workdir,
        Labels: { ...entry.labels },
      },
      NetworkSettings: { Ports: ports },
      HostConfig: {
        PortBindings: Object.fromEntries(
          container.ports.map((port) => [
            `${port.containerPort}/${port.proto}`,
            [{ HostIp: port.hostIp || '', HostPort: String(port.hostPort) }],
          ])
        ),
      },
    };
  },

  _imageInspect(image) {
    const entry = image.entry;
    return {
      Id: image.id,
      Digest: image.digest,
      RepoTags: [...image.names],
      RepoDigests: [`${entry.repo}@${image.digest}`],
      Created: entry.created,
      Config: {
        User: entry.user,
        ExposedPorts: Object.fromEntries((entry.exposes || []).map((port) => [`${port}/tcp`, {}])),
        Env: entry.env,
        Cmd: entry.cmd,
        WorkingDir: entry.workdir,
        Labels: entry.labels,
      },
      Version: '',
      Author: '',
      Architecture: 'amd64',
      Os: 'linux',
      Size: entry.sizeMB * 1000 * 1000,
      Labels: entry.labels,
    };
  },

  // ── skopeo against the workstation registry catalog ──────────────────────

  /**
   * `skopeo inspect` for an image of the registry catalog (null = not a catalog image,
   * ShellTools falls back to its cluster-backed path). Tags of one repository are aliases
   * of the same image here, so every spelling reports the digest podman pulls.
   */
  _skopeoCatalogInspect(bare, format) {
    const host = this.host;
    if (!host) return null;
    const resolved = host.resolveImageRef(bare);
    if (resolved.error || !resolved.entry || resolved.alias) return null;
    const entry = resolved.entry;
    if (!entry.tags.includes(resolved.tag)) {
      return fail(
        `FATA[0001] Error parsing image name "docker://${bare}": reading manifest ${resolved.tag} in ${entry.repo}: manifest unknown`
      );
    }
    const data = {
      Name: entry.repo,
      Digest: imageDigest(`${entry.repo}:${resolved.tag}`),
      RepoTags: [...entry.tags].sort(),
      Created: entry.created,
      DockerVersion: '',
      Labels: {
        architecture: 'x86_64',
        'com.redhat.component': `${String(entry.labels.name || entry.repo.split('/').pop()).replace(/\//g, '-')}-container`,
        ...entry.labels,
      },
      Architecture: 'amd64',
      Os: 'linux',
      Layers: [
        `sha256:${fakeSha256(`blob-a-${entry.repo}`)}`,
        `sha256:${fakeSha256(`blob-b-${entry.repo}`)}`,
      ],
      LayersData: [
        {
          MIMEType: 'application/vnd.oci.image.layer.v1.tar+gzip',
          Digest: `sha256:${fakeSha256(`blob-a-${entry.repo}`)}`,
          Size: Math.round(entry.sizeMB * 0.38 * 1000 * 1000),
          Annotations: null,
        },
        {
          MIMEType: 'application/vnd.oci.image.layer.v1.tar+gzip',
          Digest: `sha256:${fakeSha256(`blob-b-${entry.repo}`)}`,
          Size: Math.round(entry.sizeMB * 0.12 * 1000 * 1000),
          Annotations: null,
        },
      ],
      Env: [...entry.env],
    };
    if (format !== null && format !== undefined) return ok(goTemplate(String(format), data));
    return ok(JSON.stringify(data, null, 4));
  },

  /** `skopeo list-tags docker://REPO`. */
  _skopeoListTags(args) {
    const reference = args.find((arg) => !arg.startsWith('-'));
    if (!reference) return fail('FATA[0000] Exactly one non-option argument expected');
    const resolved = this.host.resolveImageRef(String(reference).replace(/^docker:\/\//, ''));
    if (resolved.error || !resolved.entry) {
      return fail(
        `FATA[0001] Error listing repository tags: fetching tags list: repository name not known to registry`
      );
    }
    return ok(
      JSON.stringify(
        { Repository: resolved.entry.repo, Tags: [...resolved.entry.tags].sort() },
        null,
        4
      )
    );
  },

  // ── curl through the workstation resolver ────────────────────────────────

  /**
   * HTTP(S) targets the workstation itself decides (null = let the router/internet paths
   * answer, so Route curls behave exactly as before): `/etc/hosts` overrides (a stale
   * entry → `No route to host`), localhost/workstation services (httpd, published podman
   * ports), seeded lab names that point at the workstation, and the cluster API endpoint.
   * @returns {object|null} a `trafficForWorkstationCurl`-shaped response
   */
  _workstationHostCurl(parsed, options = {}) {
    const host = this.host;
    if (!host) return null;
    const name = String(parsed?.hostname || '')
      .toLowerCase()
      .replace(/^\[|\]$/g, '');
    if (!name) return null;
    const scheme = parsed.scheme;
    const port = Number(parsed.port) || (scheme === 'https' ? 443 : 80);
    const path = parsed.path || '/';
    const method = options.head ? 'HEAD' : options.method || 'GET';
    const apiNames = [`api.${CLUSTER_DOMAIN}`, `api-int.${CLUSTER_DOMAIN}`];
    let ip = null;
    let fromHostsFile = false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(name) || name === '::1')
      ip = name === '::1' ? '127.0.0.1' : name;
    else {
      const entry = host.resolveHostsFile(name);
      if (entry) {
        ip = entry.ip;
        fromHostsFile = true;
      } else if (apiNames.includes(name)) ip = API_VIP;
      else {
        const record = host.dnsLookupWithSearch(name);
        if (record && host.isLocalAddress(record.ip)) ip = record.ip;
        else return null;
      }
    }
    const base = { scheme, host: name, port, path, serverIp: ip };
    if (host.isLocalAddress(ip)) {
      const served = host.serveLocalHttp({ host: name, port, path, method, scheme });
      if (served.error) return { ...base, error: served.error };
      return {
        ...base,
        ...served,
        serverIp: ip === '0.0.0.0' ? '127.0.0.1' : ip,
        serverCert: null,
      };
    }
    if (ip === API_VIP) {
      if (port !== 6443) {
        return {
          ...base,
          error: {
            code: 7,
            message: `Failed to connect to ${name} port ${port} after 1 ms: Couldn't connect to server`,
          },
        };
      }
      return this._apiServerHttp({ ...base, method });
    }
    if (!fromHostsFile) return null;
    if (ip === INGRESS_VIP) return null;
    if (!host.isReachable(ip)) {
      return {
        ...base,
        error: {
          code: 7,
          message: `Failed to connect to ${name} port ${port} after 3062 ms: No route to host`,
        },
      };
    }
    return {
      ...base,
      error: {
        code: 7,
        message: `Failed to connect to ${name} port ${port} after 0 ms: Couldn't connect to server`,
      },
    };
  },

  /** The kube-apiserver behind api.cluster.example.com:6443 for anonymous curl. */
  _apiServerHttp(base) {
    const host = this.host;
    const date = new Date(host.now()).toUTCString();
    const uuid = (seed) =>
      fakeSha256(seed).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5');
    const cleanPath = String(base.path || '/').split('?')[0];
    const serverCert = {
      trusted: false,
      selfSigned: false,
      problem: 'self-signed certificate in certificate chain',
      commonName: `api.${CLUSTER_DOMAIN}`,
      sans: [`api.${CLUSTER_DOMAIN}`, `api-int.${CLUSTER_DOMAIN}`],
      subject: { commonName: `api.${CLUSTER_DOMAIN}` },
      issuer: { organizationalUnit: 'openshift', commonName: 'kube-apiserver-lb-signer' },
    };
    const headers = (contentType, body) => ({
      'audit-id': uuid(`audit-${host.now()}`),
      'cache-control': 'no-cache, private',
      'content-type': contentType,
      'x-content-type-options': 'nosniff',
      'x-kubernetes-pf-flowschema-uid': uuid('flowschema'),
      'x-kubernetes-pf-prioritylevel-uid': uuid('prioritylevel'),
      'content-length': String(byteLength(body)),
      date,
    });
    if (['/readyz', '/livez', '/healthz'].includes(cleanPath)) {
      return {
        ...base,
        status: 200,
        statusText: 'OK',
        headers: headers('text/plain; charset=utf-8', 'ok'),
        body: 'ok',
        serverCert,
      };
    }
    if (cleanPath === '/version') {
      const body = JSON.stringify(
        {
          major: '1',
          minor: '35',
          gitVersion: 'v1.35.2',
          gitCommit: '8e7c4f1d0f6a2b9c3d5e7f9a1b3c5d7e9f1a3b5c',
          gitTreeState: 'clean',
          buildDate: '2026-10-28T09:12:44Z',
          goVersion: 'go1.24.6 (Red Hat 1.24.6-1.el9_6) X:strictfipsruntime',
          compiler: 'gc',
          platform: 'linux/amd64',
        },
        null,
        2
      );
      return {
        ...base,
        status: 200,
        statusText: 'OK',
        headers: headers('application/json', body),
        body,
        serverCert,
      };
    }
    const body = JSON.stringify(
      {
        kind: 'Status',
        apiVersion: 'v1',
        metadata: {},
        status: 'Failure',
        message: `forbidden: User "system:anonymous" cannot get path "${cleanPath}"`,
        reason: 'Forbidden',
        details: {},
        code: 403,
      },
      null,
      2
    );
    return {
      ...base,
      status: 403,
      statusText: 'Forbidden',
      headers: headers('application/json', body),
      body,
      serverCert,
    };
  },

  // ── scripts, test, source ────────────────────────────────────────────────

  _cmd_test(args) {
    return this._testResult(args);
  },

  ['_cmd_['](args) {
    if (args[args.length - 1] !== ']') return fail("bash: [: missing `]'", 2);
    return this._testResult(args.slice(0, -1));
  },

  ['_cmd_[['](args) {
    if (args[args.length - 1] !== ']]')
      return fail("bash: syntax error in conditional expression: unexpected token `newline'", 2);
    return this._testResult(args.slice(0, -1), { extended: true });
  },

  _testResult(args, { extended = false } = {}) {
    const value = this._evalTest(args, { extended });
    if (value === null) return fail(`bash: ${extended ? '[[' : '['}: syntax error`, 2);
    return value ? ok('') : { error: false, message: '', exitCode: 1 };
  },

  /** test(1) / [[ ]] expression evaluation → true/false/null (syntax error). */
  _evalTest(tokens, { extended = false } = {}) {
    const host = this.host;
    const user = this._user();
    const words = [...tokens];
    const orParts = [];
    let current = [];
    for (const word of words) {
      if (word === '-o' || (extended && word === '||')) {
        orParts.push(current);
        current = [];
      } else current.push(word);
    }
    orParts.push(current);
    const evalAnd = (part) => {
      const groups = [];
      let group = [];
      for (const word of part) {
        if (word === '-a' || (extended && word === '&&')) {
          groups.push(group);
          group = [];
        } else group.push(word);
      }
      groups.push(group);
      return groups.every((expr) => evalSimple(expr));
    };
    const evalSimple = (expr) => {
      if (!expr.length) return false;
      if (expr[0] === '!') return !evalSimple(expr.slice(1));
      if (expr.length === 1) return expr[0] !== '';
      if (expr.length === 2) {
        const [op, operand] = expr;
        const stat = (follow = true) => host.stat(operand, { user, follow });
        switch (op) {
          case '-e':
          case '-a':
            return stat().ok;
          case '-f':
            return stat().ok && stat().node.type === 'file';
          case '-d':
            return stat().ok && stat().node.type === 'dir';
          case '-L':
          case '-h':
            return stat(false).ok && stat(false).node.type === 'link';
          case '-s':
            return (
              stat().ok &&
              stat().node.type === 'file' &&
              byteLength(host._content(stat().path, stat().node)) > 0
            );
          case '-r':
            return stat().ok && host._can(stat().node, host.identity(user), 4);
          case '-w':
            return stat().ok && host._can(stat().node, host.identity(user), 2);
          case '-x':
            return stat().ok && host._can(stat().node, host.identity(user), 1);
          case '-n':
            return operand !== '';
          case '-z':
            return operand === '';
          default:
            return false;
        }
      }
      if (expr.length === 3) {
        const [left, op, right] = expr;
        const a = Number(left);
        const b = Number(right);
        switch (op) {
          case '=':
          case '==':
            return extended && /[*?[]/.test(right) ? globMatch(right, left) : left === right;
          case '!=':
            return left !== right;
          case '=~':
            try {
              return new RegExp(right).test(left) || left.includes(right);
            } catch {
              return left.includes(right);
            }
          case '-eq':
            return a === b;
          case '-ne':
            return a !== b;
          case '-lt':
            return a < b;
          case '-le':
            return a <= b;
          case '-gt':
            return a > b;
          case '-ge':
            return a >= b;
          default:
            return false;
        }
      }
      return false;
    };
    return orParts.some((part) => evalAnd(part));
  },

  _cmd_source(args) {
    const file = args[0];
    if (!file)
      return fail(
        'bash: source: filename argument required\nsource: usage: source filename [arguments]',
        2
      );
    const host = this.host;
    let path = file;
    if (!file.includes('/')) {
      const found = host.findOnPath(file, this.exportedEnvironment().PATH, { user: this._user() });
      if (found) path = found.path;
    }
    const resolved = host.resolvePath(path);
    // The global RHEL rc files only set interactive defaults this shell already has.
    if (resolved === '/etc/bashrc' || resolved === '/etc/profile') return ok('');
    const read = this._readFileResult(path);
    if (!read.ok) return fail(`bash: ${file}: ${errnoText(read.error)}`);
    return this._runScriptText(read.content, { name: file, args: args.slice(1), source: true });
  },

  ['_cmd_.'](args) {
    return this._cmd_source(args);
  },

  _cmd_sh(args, stdin) {
    return this._cmd_bash(args, stdin, 'sh');
  },

  _cmd_bash(args, stdin, shellName = 'bash') {
    let trace = false;
    let index = 0;
    while (index < args.length && args[index].startsWith('-')) {
      const arg = args[index];
      if (arg === '-c') {
        const script = args[index + 1];
        if (script === undefined) return fail(`${shellName}: -c: option requires an argument`, 2);
        return this._runScriptText(script, {
          name: args[index + 2] || shellName,
          args: args.slice(index + 3),
          trace,
        });
      }
      if (arg === '-x') trace = true;
      else if (arg === '-n' || arg === '-e' || arg === '-u' || arg === '-l' || arg === '--login') {
        /* accepted */
      } else if (arg === '--version') {
        return ok(
          'GNU bash, version 5.1.8(1)-release (x86_64-redhat-linux-gnu)\nCopyright (C) 2020 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <http://gnu.org/licenses/gpl.html>\n\nThis is free software; you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.'
        );
      }
      index += 1;
    }
    const file = args[index];
    if (!file) {
      if (stdin !== null && stdin !== undefined && stdin !== '')
        return this._runScriptText(String(stdin), { name: shellName, trace });
      return ok('');
    }
    const read = this._readFileResult(file);
    if (!read.ok)
      return fail(
        `${shellName}: ${file}: ${errnoText(read.error)}`,
        read.error === 'ENOENT' ? 127 : 126
      );
    if (args.includes('-n')) return ok('');
    return this._runScriptText(read.content, { name: file, args: args.slice(index + 1), trace });
  },

  /** `./script.sh`, `/usr/bin/ls`, or a script found on $PATH. */
  _runExecutable(command, args, stdin) {
    const host = this.host;
    const user = this._user();
    let path = command;
    if (!command.includes('/')) {
      const found = host.findOnPath(command, this.exportedEnvironment().PATH, { user });
      if (!found) return fail(`bash: ${command}: command not found`, 127);
      path = found.path;
    }
    const shown = command.includes('/') ? command : path;
    const found = host.stat(path, { user });
    if (!found.ok)
      return fail(
        `bash: ${shown}: ${errnoText(found.error)}`,
        found.error === 'ENOENT' ? 127 : 126
      );
    if (found.node.type === 'dir') return fail(`bash: ${shown}: Is a directory`, 126);
    if (!host._can(found.node, host.identity(user), 1))
      return fail(`bash: ${shown}: Permission denied`, 126);
    if (found.node.binary) {
      const name = basenameOf(found.path);
      if (this[`_cmd_${name}`] && name !== basenameOf(command).replace(/\.sh$/, '_'))
        return this.runTokens([name, ...args], stdin);
      return fail(`bash: ${shown}: cannot execute binary file: Exec format error`, 126);
    }
    const read = this._readFileResult(path);
    if (!read.ok) return fail(`bash: ${shown}: ${errnoText(read.error)}`, 126);
    const shebang = read.content.match(/^#!\s*(\S+)/);
    if (shebang && !/(ba)?sh$/.test(shebang[1])) {
      return fail(
        `${shown}: line 1: ${shebang[1]}: (simulator) only shell scripts can run on this workstation`,
        126
      );
    }
    return this._runScriptText(read.content, { name: shown, args });
  },

  /**
   * Run a shell script: `#` comments, if/elif/else/fi, for/do/done, `exit N`, and every
   * simple command through the normal segment runner (pipes, redirects, `&&`, `oc`).
   * `source` runs in the current shell; otherwise variables, exports and `cd` stay inside.
   */
  _runScriptText(text, { name = 'bash', args = [], source = false, trace = false } = {}) {
    const host = this.host;
    if (this._scriptDepth > 16)
      return fail(`bash: ${name}: maximum script nesting level exceeded`, 1);
    const parsed = parseScript(String(text ?? ''));
    if (parsed.error) return fail(`${name}: line ${parsed.line}: ${parsed.error}`, 2);
    const session = host.session;
    const saved = {
      vars: session.vars,
      env: session.env,
      cwd: session.cwd,
      params: this._scriptParams,
    };
    if (!source) {
      session.vars = new Map();
      session.env = new Map(saved.env);
    }
    const params = { 0: name, '#': String(args.length), '@': args.join(' '), '*': args.join(' ') };
    args.slice(0, 9).forEach((value, index) => {
      params[String(index + 1)] = value;
    });
    if (!source || args.length) this._scriptParams = { ...(saved.params || {}), ...params };
    this._scriptDepth += 1;
    const outputs = [];
    let status = 0;
    let errorText = false;
    const runBlock = (statements) => {
      for (const statement of statements) {
        const result = runStatement(statement);
        if (result === 'exit') return 'exit';
      }
      return null;
    };
    const runStatement = (statement) => {
      if (statement.type === 'cmd') {
        if (trace) outputs.push(`+ ${this.expandVariables(statement.text)}`);
        const result = this._runScriptLine(statement.text);
        if (result.output) outputs.push(result.output);
        status = result.exitCode;
        if (result.exitCode && result.error) errorText = true;
        if (result.exit) return 'exit';
        return null;
      }
      if (statement.type === 'if') {
        for (const branch of statement.branches) {
          if (branch.condition === null || this._runScriptLine(branch.condition).exitCode === 0) {
            return runBlock(branch.body);
          }
        }
        status = 0;
        return null;
      }
      if (statement.type === 'for') {
        const expanded = this.expandVariables(statement.words);
        const words = this.expandWords(expanded).words || [];
        for (const word of words) {
          this.setSessionVariable(statement.variable, word);
          if (runBlock(statement.body) === 'exit') return 'exit';
        }
        return null;
      }
      return null;
    };
    try {
      runBlock(parsed.statements);
    } finally {
      this._scriptDepth -= 1;
      this._scriptParams = saved.params;
      if (!source) {
        session.vars = saved.vars;
        session.env = saved.env;
        session.cwd = saved.cwd;
      }
    }
    const message = outputs.filter((line) => line !== '').join('\n');
    if (status !== 0)
      return { error: errorText, message, exitCode: status, silentFailure: !message };
    return ok(message);
  },

  /** One script line: substitutions, `;`/`&&`/`||`, assignments, `exit`, segments. */
  _runScriptLine(line) {
    const pre = this.preprocess(line);
    const plan = this.splitCommandLine(pre.command);
    if (plan.error)
      return { error: true, output: plan.error.replace(/^simulator: /, 'bash: '), exitCode: 2 };
    const outputs = [];
    let status = 0;
    let error = false;
    for (let index = 0; index < plan.segments.length; index += 1) {
      const separator = index === 0 ? null : plan.operators[index - 1];
      if (separator === '&&' && status !== 0) continue;
      if (separator === '||' && status === 0) continue;
      let expanded = this.expandVariables(plan.segments[index]);
      // `! pipeline` inverts the status (the RHEL skel .bashrc uses `if ! [[ … ]]`).
      const negate = /^\s*!\s+/.test(expanded);
      if (negate) expanded = expanded.replace(/^\s*!\s+/, '');
      const assignment = this.parseShellAssignment(expanded);
      if (assignment) {
        this.setSessionVariable(assignment.name, assignment.value);
        status = 0;
        continue;
      }
      const words = expanded.trim().split(/\s+/);
      if (words[0] === 'exit') {
        const code = Number(words[1] ?? this.lastExitCode ?? 0) & 0xff;
        return { output: outputs.join('\n'), exitCode: code, exit: true, error: code !== 0 };
      }
      let result;
      if (typeof this.bar?._runSegment === 'function')
        result = this.bar._runSegment(expanded, null, false);
      else {
        const stage = this.runShellStage(expanded, null);
        result = {
          error: stage.error,
          message: stage.message,
          output: stage.error ? '' : stage.message,
          exitCode: stage.exitCode,
        };
      }
      const text = result.error ? result.message || '' : result.output || '';
      if (text) outputs.push(String(text).replace(/\n$/, ''));
      status = Number.isFinite(result.exitCode) ? result.exitCode : result.error ? 1 : 0;
      error = Boolean(result.error);
      if (negate) {
        status = status === 0 ? 1 : 0;
        error = false;
      }
      this.lastExitCode = status;
    }
    return { output: outputs.join('\n'), exitCode: status, error };
  },

  _cmd_exit(args) {
    if (this.host.popLogin()) return ok('logout');
    void args;
    return { error: false, message: '', exit: true };
  },

  // ── editors (the Files panel) ────────────────────────────────────────────

  _cmd_nano(args) {
    return this._openEditor(args, 'nano');
  },

  /**
   * vim/vi/nano open the Files panel. Home/tmp files open directly; any other file opens
   * as an editable copy under `.oc/host/<path>` that LinuxHost writes back on the next
   * command — only when the effective user may write the real file (`sudo vim`).
   */
  _openEditor(args, editor = 'vim') {
    const host = this.host;
    const path = args.find((arg) => !arg.startsWith('-') && !arg.startsWith('+'));
    const panel = this.bar?.game?.manifestPanel || this.bar?.manifestPanel;
    if (!path) {
      if (panel && typeof panel.show === 'function') {
        panel.show();
        return ok(
          'Opening the Files panel (manifest editor). Use `vim <file>` to edit a specific manifest.'
        );
      }
      return fail('vim: the manifest editor is not available in this build');
    }
    const user = this._user();
    const identity = host.identity(user);
    const found = host.stat(path, { user });
    if (found.ok && found.node.type === 'dir') return fail(`"${path}" is a directory`);
    if (!found.ok && found.error !== 'ENOENT') return fail(`"${path}" [Permission Denied]`);
    if (found.ok && !host._can(found.node, identity, 4))
      return fail(`"${path}" [Permission Denied]`);
    if (found.ok && !host._can(found.node, identity, 2)) {
      return fail(
        `"${path}" [readonly]\nE45: 'readonly' option is set (add ! to override)\n(${user} cannot write ${path} — run: sudo ${editor} ${path})`
      );
    }
    if (!found.ok) {
      const created = host.writeFile(path, '', { user });
      if (created.error)
        return fail(`"${path}" E212: Can't open file for writing: ${errnoText(created.error)}`);
    }
    const stat = host.stat(path, { user: 'root' });
    const abs = stat.path;
    const key = host.vfsKey(abs);
    let panelKey = key;
    let note = '';
    if (key === null || stat.node.hostOnly) {
      panelKey = `${MIRROR_PREFIX}${abs}`;
      const store = host._store();
      const content = host._content(abs, stat.node);
      if (store) {
        store.writeFile(panelKey, content);
        host.mirrors.set(panelKey, { path: abs, synced: content });
      }
      note = ` (editable copy ${panelKey} — saved changes are written back to ${abs})`;
    }
    this._refreshFilesPanel();
    if (panel && typeof panel.openFile === 'function') {
      panel.openFile(panelKey);
      return ok(
        `Opening ${path} in the Files panel (manifest editor)${note}.\nSave (Ctrl+S) to write the file${/\.(ya?ml|json)$/.test(abs) ? `, then apply it with \`oc apply -f ${path}\`` : ''}.`
      );
    }
    return ok(
      `${path}\n(On a real system ${editor} opens this file in the terminal; this simulator opens the Files panel when available.)${note}`
    );
  },

  // ── archives ─────────────────────────────────────────────────────────────

  _cmd_tar(args) {
    const host = this.host;
    const user = this._user();
    const normalized = [];
    args.forEach((arg, index) => {
      if (index === 0 && /^[A-Za-z]+$/.test(arg) && /[ctx]/.test(arg)) normalized.push(`-${arg}`);
      else normalized.push(arg);
    });
    const { flags, values, longs, positionals } = parseArgs(normalized, {
      valueShort: 'fC',
      valueLong: ['file', 'directory', 'exclude'],
    });
    const archive = values.get('f') ?? longs.get('file');
    const dir = values.get('C') ?? longs.get('directory') ?? null;
    const verbose = flags.has('v');
    const gzip = flags.has('z') || flags.has('j') || flags.has('J');
    const mode = flags.has('c')
      ? 'create'
      : flags.has('x')
        ? 'extract'
        : flags.has('t')
          ? 'list'
          : null;
    if (!mode)
      return fail(
        "tar: You must specify one of the '-Acdtrux', '--delete' or '--test-label' options\nTry 'tar --help' or 'tar --usage' for more information.",
        2
      );
    const base = dir ? host.resolvePath(dir) : host.session.cwd;
    if (mode === 'create') {
      if (!archive)
        return fail(
          'tar: Refusing to write archive contents to terminal (missing -f option?)\ntar: Error is not recoverable: exiting now',
          2
        );
      if (!positionals.length)
        return fail(
          "tar: Cowardly refusing to create an empty archive\nTry 'tar --help' or 'tar --usage' for more information.",
          2
        );
      const entries = [];
      const out = [];
      const errors = [];
      let strippedLeading = false;
      const visit = (memberName, abs) => {
        const found = host.stat(abs, { user, follow: false });
        if (!found.ok) {
          errors.push(`tar: ${memberName}: Cannot stat: ${errnoText(found.error)}`);
          return;
        }
        const node = found.node;
        const record = {
          name: memberName,
          type: node.type,
          mode: node.mode,
          owner: host.userName(node.uid),
          group: host.groupName(node.gid),
          mtime: node.mtime,
          context: node.context,
        };
        if (node.type === 'dir') {
          record.name = `${memberName.replace(/\/+$/, '')}/`;
          entries.push(record);
          if (verbose) out.push(record.name);
          const listing = host.readdir(abs, { user });
          if (!listing.ok) {
            errors.push(`tar: ${memberName}: Cannot open: ${errnoText(listing.error)}`);
            return;
          }
          for (const child of listing.entries)
            visit(`${memberName.replace(/\/+$/, '')}/${child.name}`, child.path);
          return;
        }
        if (node.type === 'link') record.target = node.target;
        else {
          const read = host.readFile(abs, { user });
          if (!read.ok) {
            errors.push(`tar: ${memberName}: Cannot open: ${errnoText(read.error)}`);
            return;
          }
          record.content = read.content;
          record.size = byteLength(read.content);
        }
        entries.push(record);
        if (verbose) out.push(memberName);
      };
      for (const member of positionals) {
        let memberName = member;
        if (memberName.startsWith('/')) {
          memberName = memberName.replace(/^\/+/, '');
          if (!strippedLeading) {
            out.unshift("tar: Removing leading `/' from member names");
            strippedLeading = true;
          }
        }
        visit(memberName, host.resolvePath(member, { cwd: base }));
      }
      const payload = `${gzip ? '\u001f\u008b\u0008\u0000' : 'ustar\u0000'}${toBase64(JSON.stringify(entries))}`;
      const written = host.writeFile(archive, payload, { user });
      if (written.error)
        return fail(
          `tar (child): ${archive}: Cannot open: ${errnoText(written.error)}\ntar (child): Error is not recoverable: exiting now\ntar: Child returned status 2\ntar: Error is not recoverable: exiting now`,
          2
        );
      this._refreshFilesPanel();
      if (errors.length)
        return fail(
          [...out, ...errors, 'tar: Exiting with failure status due to previous errors'].join('\n'),
          2
        );
      return ok(out.join('\n'));
    }
    if (!archive)
      return fail(
        'tar: Refusing to read archive contents from terminal (missing -f option?)\ntar: Error is not recoverable: exiting now',
        2
      );
    const read = this._readFileResult(archive);
    if (!read.ok)
      return fail(
        `tar: ${archive}: Cannot open: ${errnoText(read.error)}\ntar: Error is not recoverable: exiting now`,
        2
      );
    const entries = parseArchive(read.content);
    if (!entries) {
      if (gzip)
        return fail(
          'gzip: stdin: not in gzip format\ntar: Child returned status 1\ntar: Error is not recoverable: exiting now',
          2
        );
      return fail(
        'tar: This does not look like a tar archive\ntar: Exiting with failure status due to previous errors',
        2
      );
    }
    const wanted = positionals.length ? positionals : null;
    const selected = entries.filter(
      (entry) =>
        !wanted ||
        wanted.some(
          (name) =>
            entry.name === name ||
            entry.name.startsWith(`${name.replace(/\/+$/, '')}/`) ||
            entry.name === `${name}/`
        )
    );
    if (mode === 'list') {
      return ok(
        selected
          .map((entry) =>
            verbose
              ? `${modeString(entry.type, entry.mode)} ${`${entry.owner}/${entry.group}`.padEnd(17)} ${String(entry.size || 0).padStart(8)} ${new Date(entry.mtime || host.now()).toISOString().slice(0, 16).replace('T', ' ')} ${entry.name}${entry.type === 'link' ? ` -> ${entry.target}` : ''}`
              : entry.name
          )
          .join('\n')
      );
    }
    const out = [];
    const errors = [];
    for (const entry of selected) {
      const target = host.resolvePath(entry.name, { cwd: base });
      if (verbose) out.push(entry.name);
      if (entry.type === 'dir') {
        const made = host.mkdir(target, { user, parents: true });
        if (made.error && made.error !== 'EEXIST')
          errors.push(`tar: ${entry.name}: Cannot mkdir: ${errnoText(made.error)}`);
        continue;
      }
      host.mkdir(dirnameOf(target), { user, parents: true });
      if (entry.type === 'link') {
        host.symlink(entry.target, target, { user });
        continue;
      }
      const written = host.writeFile(target, entry.content ?? '', { user });
      if (written.error) {
        errors.push(`tar: ${entry.name}: Cannot open: ${errnoText(written.error)}`);
        continue;
      }
      host.chmod(target, (entry.mode & 0o7777).toString(8), { user: 'root' });
      if (user === 'root')
        host.chown(target, { owner: entry.owner, group: entry.group }, { user: 'root' });
    }
    this._refreshFilesPanel();
    if (errors.length)
      return fail(
        [...out, ...errors, 'tar: Exiting with failure status due to previous errors'].join('\n'),
        2
      );
    return ok(out.join('\n'));
  },

  _cmd_gzip(args) {
    const host = this.host;
    const { flags, positionals } = parseArgs(args);
    if (flags.has('d')) return this._cmd_gunzip(positionals);
    for (const file of positionals) {
      const read = this._readFileResult(file);
      if (!read.ok) return fail(`gzip: ${file}: ${errnoText(read.error)}`);
      if (file.endsWith('.gz')) return fail(`gzip: ${file} already has .gz suffix -- unchanged`, 2);
      const written = host.writeFile(
        `${file}.gz`,
        `\u001f\u008b\u0008\u0000${toBase64(read.content)}`,
        { user: this._user() }
      );
      if (written.error) return fail(`gzip: ${file}.gz: ${errnoText(written.error)}`);
      if (!flags.has('k')) host.unlink(file, { user: this._user() });
    }
    this._refreshFilesPanel();
    return ok('');
  },

  _cmd_gunzip(args) {
    const host = this.host;
    const files = args.filter((arg) => !arg.startsWith('-'));
    for (const file of files) {
      const read = this._readFileResult(file);
      if (!read.ok) return fail(`gzip: ${file}: ${errnoText(read.error)}`);
      if (!read.content.startsWith('\u001f\u008b'))
        return fail(`gzip: ${file}: not in gzip format`);
      const plain = fromBase64(read.content.slice(4));
      host.writeFile(file.replace(/\.gz$/, ''), plain, { user: this._user() });
      host.unlink(file, { user: this._user() });
    }
    this._refreshFilesPanel();
    return ok('');
  },

  _cmd_zcat(args) {
    const out = [];
    for (const file of args.filter((arg) => !arg.startsWith('-'))) {
      const read = this._readFileResult(file);
      if (!read.ok) return fail(`gzip: ${file}: ${errnoText(read.error)}`);
      if (!read.content.startsWith('\u001f\u008b'))
        return fail(`gzip: ${file}: not in gzip format`);
      out.push(fromBase64(read.content.slice(4)).replace(/\n$/, ''));
    }
    return ok(out.join('\n'));
  },

  // ── misc utilities ───────────────────────────────────────────────────────

  _cmd_tree(args) {
    const host = this.host;
    const { flags, values, positionals } = parseArgs(args, { valueShort: 'L' });
    const maxDepth = values.has('L') ? Number(values.get('L')) : Infinity;
    const roots = positionals.length ? positionals : ['.'];
    const out = [];
    let dirs = 0;
    let files = 0;
    const walk = (path, prefix, depth) => {
      if (depth >= maxDepth) return;
      const listing = host.readdir(path, { user: this._user() });
      if (!listing.ok) return;
      const entries = listing.entries.filter(
        (entry) =>
          (flags.has('a') || !entry.name.startsWith('.')) &&
          (!flags.has('d') || entry.node.type === 'dir')
      );
      entries.forEach((entry, index) => {
        const last = index === entries.length - 1;
        out.push(
          `${prefix}${last ? '└── ' : '├── '}${entry.name}${entry.node.type === 'link' ? ` -> ${entry.node.target}` : ''}`
        );
        if (entry.node.type === 'dir') {
          dirs += 1;
          walk(entry.path, `${prefix}${last ? '    ' : '│   '}`, depth + 1);
        } else files += 1;
      });
    };
    for (const root of roots) {
      const found = host.stat(root, { user: this._user() });
      if (!found.ok) {
        out.push(`${root}  [error opening dir]`);
        continue;
      }
      out.push(root);
      walk(found.path, '', 0);
    }
    out.push(
      '',
      flags.has('d')
        ? `${dirs} director${dirs === 1 ? 'y' : 'ies'}`
        : `${dirs} director${dirs === 1 ? 'y' : 'ies'}, ${files} file${files === 1 ? '' : 's'}`
    );
    return ok(out.join('\n'));
  },

  _cmd_awk(args, stdin) {
    let separator = null;
    let index = 0;
    while (index < args.length && args[index].startsWith('-')) {
      if (args[index] === '-F') separator = args[++index];
      else if (args[index].startsWith('-F')) separator = args[index].slice(2);
      index += 1;
    }
    const program = args[index];
    const files = args.slice(index + 1);
    if (program === undefined)
      return fail(
        "usage: awk [POSIX or GNU style options] -f progfile [--] file ...\nusage: awk [POSIX or GNU style options] [--] 'program' file ...",
        2
      );
    let input = stdin ?? '';
    if (files.length) {
      const chunks = [];
      for (const file of files) {
        const read = this._readFileResult(file);
        if (!read.ok)
          return fail(
            `awk: fatal: cannot open file \`${file}' for reading: ${errnoText(read.error)}`,
            2
          );
        chunks.push(read.content.endsWith('\n') ? read.content : `${read.content}\n`);
      }
      input = chunks.join('');
    }
    const match = String(program)
      .trim()
      .match(
        /^(?:(\/(?:\\.|[^/])*\/|NR\s*[=!<>]=?\s*\d+|\$\d+\s*(?:==|!=|>=|<=|>|<|~)\s*(?:"[^"]*"|\/[^/]*\/|-?\d+))\s*)?(?:\{\s*(.*?)\s*\})?$/
      );
    if (!match)
      return fail(
        `awk: cmd. line:1: ${program}\nawk: cmd. line:1: ^ syntax error (simulator supports: awk [-F sep] '[/re/ | NR==n | $n op v] {print $1, $2}')`,
        2
      );
    const [, condition, action] = match;
    const lines = String(input).split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const out = [];
    lines.forEach((line, lineIndex) => {
      const fields =
        separator === null
          ? line.trim().split(/\s+/).filter(Boolean)
          : line.split(separator === '\\t' ? '\t' : separator);
      const field = (n) => (n === 0 ? line : (fields[n - 1] ?? ''));
      if (condition) {
        if (condition.startsWith('/')) {
          if (!new RegExp(condition.slice(1, -1)).test(line)) return;
        } else if (condition.startsWith('NR')) {
          const [, op, value] = condition.match(/NR\s*([=!<>]=?)\s*(\d+)/);
          const nr = lineIndex + 1;
          const target = Number(value);
          const okLine =
            op === '==' || op === '='
              ? nr === target
              : op === '!='
                ? nr !== target
                : op === '>'
                  ? nr > target
                  : op === '<'
                    ? nr < target
                    : op === '>='
                      ? nr >= target
                      : nr <= target;
          if (!okLine) return;
        } else {
          const [, n, op, rawValue] = condition.match(/\$(\d+)\s*(==|!=|>=|<=|>|<|~)\s*(.*)$/);
          const left = field(Number(n));
          const value = rawValue.replace(/^"|"$/g, '');
          const numeric = /^-?\d+(\.\d+)?$/.test(value) && /^-?\d+(\.\d+)?$/.test(left);
          const a = numeric ? Number(left) : left;
          const b = numeric ? Number(value) : value;
          const keep =
            op === '~'
              ? new RegExp(value.replace(/^\/|\/$/g, '')).test(left)
              : op === '=='
                ? a === b
                : op === '!='
                  ? a !== b
                  : op === '>'
                    ? a > b
                    : op === '<'
                      ? a < b
                      : op === '>='
                        ? a >= b
                        : a <= b;
          if (!keep) return;
        }
      }
      if (!action || /^print\s*$/.test(action)) {
        out.push(line);
        return;
      }
      const print = action.match(/^print\s+(.*)$/);
      if (!print) return;
      const parts = print[1].split(/\s*,\s*/).map((part) => {
        if (part === 'NR') return String(lineIndex + 1);
        if (part === 'NF') return String(fields.length);
        if (/^\$NF$/.test(part)) return fields[fields.length - 1] ?? '';
        const fieldRef = part.match(/^\$(\d+)$/);
        if (fieldRef) return field(Number(fieldRef[1]));
        return part.replace(/^"|"$/g, '');
      });
      out.push(parts.join(' '));
    });
    return ok(out.join('\n'));
  },

  _cmd_xargs(args, stdin) {
    const words = String(stdin ?? '')
      .split(/\s+/)
      .filter(Boolean);
    const command = args.length ? args : ['echo'];
    if (!words.length) return ok('');
    return this.runTokens([...command, ...words], null);
  },

  _cmd_httpd(args) {
    if (args.includes('-v'))
      return ok(
        'Server version: Apache/2.4.62 (Red Hat Enterprise Linux)\nServer built:   Jan  9 2025 00:00:00'
      );
    if (args.includes('-t') || args.includes('-S')) return this._httpdConfigTest();
    return fail('(simulator) run httpd through systemd: sudo systemctl start httpd');
  },

  _cmd_apachectl(args) {
    const verb = args[0] || 'help';
    if (verb === 'configtest' || verb === '-t') return this._httpdConfigTest();
    if (['start', 'stop', 'restart', 'graceful', 'reload', 'status'].includes(verb)) {
      const mapped = verb === 'graceful' ? 'reload' : verb;
      return this.runTokens(['systemctl', mapped, 'httpd'], null);
    }
    return fail(
      `Usage: /usr/sbin/httpd [-D name] [-d directory] [-f file]\n                       [-C "directive"] [-c "directive"]\n                       [-k start|restart|graceful|graceful-stop|stop]\n                       [-v] [-V] [-h] [-l] [-L] [-t] [-T] [-S] [-X]`
    );
  },

  _httpdConfigTest() {
    const host = this.host;
    const error = host.httpdConfigError();
    if (error) return fail(error.lines.join('\n'));
    return ok([...host.httpdConfigWarnings(), 'Syntax OK'].join('\n'));
  },

  _cmd_sshd(args) {
    if (!args.includes('-t') && !args.includes('-T'))
      return fail('(simulator) sshd runs as a systemd service: systemctl status sshd');
    if (this._user() !== 'root') {
      return fail('sshd: no hostkeys available -- exiting.');
    }
    const error = this.host.sshdConfigError();
    if (error) return fail(error.lines.join('\n'), 255);
    return ok('');
  },

  _cmd_git(args) {
    if (args[0] === '--version' || args[0] === 'version') return ok('git version 2.47.1');
    if (args[0] === 'clone')
      return fail(
        `Cloning into '${basenameOf(String(args[1] || 'repo')).replace(/\.git$/, '')}'...\nfatal: unable to access '${args[1] || ''}': Could not resolve host: ${
          String(args[1] || '')
            .replace(/^\w+:\/\//, '')
            .split('/')[0]
        }`,
        128
      );
    return fail(`git: '${args[0] || ''}' is not a git command. See 'git --help'.`, 1);
  },

  _cmd_wget(args) {
    const url = args.find((arg) => !arg.startsWith('-'));
    if (!url)
      return fail(
        "wget: missing URL\nUsage: wget [OPTION]... [URL]...\n\nTry `wget --help' for more options."
      );
    const result = this._cmd_curl([
      '-s',
      '-o',
      basenameOf(url.replace(/[?#].*$/, '')) || 'index.html',
      url,
    ]);
    if (result.error)
      return fail(
        `--${formatDate(this.host.now())}--  ${url}\nResolving ${url.replace(/^\w+:\/\//, '').split('/')[0]}... failed: Name or service not known.\nwget: unable to resolve host address`,
        4
      );
    return ok(
      `--${new Date(this.host.now()).toISOString().replace('T', ' ').slice(0, 19)}--  ${url}\nHTTP request sent, awaiting response... 200 OK\nSaving to: ‘${basenameOf(url) || 'index.html'}’\n\n‘${basenameOf(url) || 'index.html'}’ saved`
    );
  },

  _cmd_lsof(args) {
    const host = this.host;
    const port =
      (args.find((arg) => arg.startsWith('-i')) || '').match(/:(\d+)/)?.[1] ||
      (args[args.indexOf('-i') + 1] || '').match(/:(\d+)/)?.[1];
    const sockets = host
      .listeningSockets()
      .filter((socket) => !port || String(socket.port) === port);
    if (!sockets.length) return { error: true, message: '', exitCode: 1, silentFailure: true };
    return ok(
      table(
        [
          ['COMMAND', 'PID', 'USER', 'FD', 'TYPE', 'DEVICE', 'SIZE/OFF', 'NODE', 'NAME'],
          ...sockets.map((socket) => [
            socket.comm.slice(0, 9),
            String(socket.pid),
            socket.user,
            `${socket.fd}u`,
            socket.addr.startsWith('[') || socket.addr === '*' ? 'IPv6' : 'IPv4',
            String(28000 + socket.port),
            '0t0',
            socket.proto.toUpperCase(),
            `${socket.addr === '0.0.0.0' ? '*' : socket.addr}:${socket.port} (LISTEN)`,
          ]),
        ],
        { gap: ' ' }
      )
    );
  },

  _cmd_nc(args) {
    const words = args.filter((arg) => !arg.startsWith('-'));
    const [target, port] = words;
    const resolved = this.host.resolveName(target || '');
    if (!resolved)
      return fail(
        `Ncat: Could not resolve hostname "${target}": Name or service not known. QUITTING.`,
        2
      );
    const local = this.host.isLocalAddress(resolved.ip);
    const listening =
      local && this.host.listeningSockets().some((socket) => String(socket.port) === String(port));
    if ((local && listening) || (!local && this.host.isReachable(resolved.ip))) {
      return ok(
        `Ncat: Version 7.92 ( https://nmap.org/ncat )\nNcat: Connected to ${resolved.ip}:${port}.\nNcat: 0 bytes sent, 0 bytes received in 0.01 seconds.`
      );
    }
    return fail(
      `Ncat: Version 7.92 ( https://nmap.org/ncat )\nNcat: ${local ? 'Connection refused' : 'No route to host'}.`,
      1
    );
  },

  // @@LINUX_COMMANDS_MORE@@
};

/** Parse a shell script into statements (cmd / if / for). */
function parseScript(text) {
  const raw = [];
  String(text)
    .split('\n')
    .forEach((line, lineIndex) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      // Split on `;` outside quotes so `if [ x ]; then` becomes two statements.
      let current = '';
      let quote = null;
      for (let index = 0; index < trimmed.length; index += 1) {
        const char = trimmed[index];
        if (quote) {
          if (char === quote) quote = null;
          current += char;
          continue;
        }
        if (char === '"' || char === "'") {
          quote = char;
          current += char;
          continue;
        }
        if (char === '#' && /\s/.test(trimmed[index - 1] || ' ')) break;
        if (char === ';' && trimmed[index + 1] !== ';') {
          if (current.trim()) raw.push({ text: current.trim(), line: lineIndex + 1 });
          current = '';
          continue;
        }
        current += char;
      }
      if (current.trim()) raw.push({ text: current.trim(), line: lineIndex + 1 });
    });
  // Keywords at the start of a statement are their own tokens (`then cmd` → `then`, `cmd`).
  const items = [];
  for (const entry of raw) {
    const match = entry.text.match(/^(then|do|else)\s+(.+)$/);
    if (match) {
      items.push({ text: match[1], line: entry.line }, { text: match[2], line: entry.line });
    } else items.push(entry);
  }
  let position = 0;
  const parseBlock = (terminators) => {
    const statements = [];
    while (position < items.length) {
      const item = items[position];
      const word = item.text.split(/\s+/)[0];
      if (terminators.includes(word)) return { statements, terminator: word };
      position += 1;
      if (word === 'if') {
        const branches = [];
        let condition = item.text.replace(/^if\s+/, '');
        while (true) {
          if (items[position]?.text === 'then') position += 1;
          else return { error: "syntax error near unexpected token `fi'", line: item.line };
          const block = parseBlock(['elif', 'else', 'fi']);
          if (block.error) return block;
          branches.push({ condition, body: block.statements });
          const terminatorItem = items[position];
          if (!terminatorItem)
            return { error: 'syntax error: unexpected end of file', line: item.line };
          position += 1;
          if (block.terminator === 'elif') {
            condition = terminatorItem.text.replace(/^elif\s+/, '');
            continue;
          }
          if (block.terminator === 'else') {
            const elseBlock = parseBlock(['fi']);
            if (elseBlock.error) return elseBlock;
            branches.push({ condition: null, body: elseBlock.statements });
            position += 1;
          }
          break;
        }
        statements.push({ type: 'if', branches });
        continue;
      }
      if (word === 'for') {
        const match = item.text.match(/^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.*)$/);
        if (!match) return { error: "syntax error near unexpected token `for'", line: item.line };
        if (items[position]?.text === 'do') position += 1;
        else return { error: "syntax error near unexpected token `done'", line: item.line };
        const block = parseBlock(['done']);
        if (block.error) return block;
        position += 1;
        statements.push({
          type: 'for',
          variable: match[1],
          words: match[2],
          body: block.statements,
        });
        continue;
      }
      if (
        ['while', 'until', 'case', 'function'].includes(word) ||
        /^[A-Za-z_]\w*\(\)/.test(item.text)
      ) {
        return {
          error: `(simulator) \`${word}\` is not supported in scripts — use if/for and simple commands`,
          line: item.line,
        };
      }
      if (['then', 'fi', 'done', 'do', 'elif', 'else'].includes(word))
        return { error: `syntax error near unexpected token \`${word}'`, line: item.line };
      statements.push({ type: 'cmd', text: item.text });
    }
    if (terminators.length)
      return {
        error: 'syntax error: unexpected end of file',
        line: items[items.length - 1]?.line || 1,
      };
    return { statements };
  };
  const result = parseBlock([]);
  if (result.error) return result;
  return { statements: result.statements };
}

function toBase64(text) {
  const bytes =
    typeof TextEncoder === 'function'
      ? new TextEncoder().encode(String(text))
      : Buffer.from(String(text));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  if (typeof btoa === 'function') return btoa(binary);
  return Buffer.from(binary, 'binary').toString('base64');
}

function fromBase64(text) {
  try {
    const binary =
      typeof atob === 'function' ? atob(text) : Buffer.from(text, 'base64').toString('binary');
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return typeof TextDecoder === 'function'
      ? new TextDecoder().decode(bytes)
      : Buffer.from(bytes).toString('utf8');
  } catch {
    return '';
  }
}

/** Archive payload written by `tar -c` (null when the file is not an archive). */
function parseArchive(content) {
  const text = String(content ?? '');
  let body = null;
  if (text.startsWith('\u001f\u008b\u0008\u0000')) body = text.slice(4);
  else if (text.startsWith('ustar\u0000')) body = text.slice(6);
  if (body === null) return null;
  try {
    const entries = JSON.parse(fromBase64(body));
    return Array.isArray(entries) ? entries : null;
  } catch {
    return null;
  }
}

/** All files a catalog package owns (rpm -ql / -qf / dnf provides). */
function packageFiles(pkg) {
  const files = [
    ...pkg.bins.map((bin) => `/usr/bin/${bin}`),
    ...pkg.sbins.map((bin) => `/usr/sbin/${bin}`),
    ...Object.keys(pkg.files || {}),
    ...pkg.units.map((unit) => `/usr/lib/systemd/system/${unit}.service`),
  ];
  return [...new Set(files)].sort();
}

/** dnf's "Installed:" list (two columns when they fit in 80). */
function columns(items) {
  const width = Math.max(...items.map((item) => item.length)) + 2;
  if (width * 2 + 2 > 80) return items.map((item) => `  ${item}`);
  const lines = [];
  for (let index = 0; index < items.length; index += 2) {
    lines.push(`  ${items[index].padEnd(width)}${items[index + 1] || ''}`.trimEnd());
  }
  return lines;
}

/** Minimal Go text/template for --format: `{{.A.B}}`, `{{json .X}}`, `{{range}}`-free. */
function goTemplate(template, data) {
  const goValue = (value) => {
    if (value === null || value === undefined) return '<no value>';
    if (Array.isArray(value))
      return `[${value.map((item) => (typeof item === 'object' ? goValue(item) : String(item))).join(' ')}]`;
    if (typeof value === 'object') {
      return `map[${Object.keys(value)
        .sort()
        .map((key) => `${key}:${value[key] === null ? '[]' : goValue(value[key])}`)
        .join(' ')}]`;
    }
    return String(value);
  };
  const lookup = (path) =>
    path
      .split('.')
      .filter(Boolean)
      .reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), data);
  return String(template)
    .replace(/\{\{\s*json\s+\.([\w.]*)\s*\}\}/g, (match, path) =>
      JSON.stringify(path ? lookup(path) : data)
    )
    .replace(/\{\{\s*\.([\w.]*)\s*\}\}/g, (match, path) => goValue(lookup(path)))
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');
}

const STATIC_UNIT_MESSAGE = `The unit files have no installation config (WantedBy=, RequiredBy=, UpheldBy=,
Also=, or Alias= settings in the [Install] section, and DefaultInstance= for
template units). This means they are not meant to be enabled or disabled using systemctl.
 
Possible reasons for having these kinds of units are:
• A unit may be statically enabled by being symlinked from another unit's
  .wants/, .requires/, or .upholds/ directory.
• A unit's purpose may be to act as a helper for some other unit which has
  a requirement dependency on it.
• A unit may be started when needed via activation (socket, path, timer,
  D-Bus, udev, scripted systemctl call, ...).
• In case of template units, the unit is meant to be enabled with some
  instance name specified.`;

/** Non-service units for `systemctl list-units` (name, description, sub). */
const OTHER_UNIT_ROWS = [
  ['-.mount', 'Root Mount', 'mounted'],
  ['boot.mount', '/boot', 'mounted'],
  ['boot-efi.mount', '/boot/efi', 'mounted'],
  ['dbus.socket', 'D-Bus System Message Bus Socket', 'running'],
  ['systemd-journald.socket', 'Journal Socket', 'running'],
  ['basic.target', 'Basic System', 'active'],
  ['multi-user.target', 'Multi-User System', 'active'],
  ['network-online.target', 'Network is Online', 'active'],
  ['network.target', 'Network', 'active'],
  ['sockets.target', 'Socket Units', 'active'],
  ['timers.target', 'Timer Units', 'active'],
  ['dnf-makecache.timer', 'dnf makecache --timer', 'waiting'],
  ['logrotate.timer', 'Daily rotation of log files', 'waiting'],
  ['systemd-tmpfiles-clean.timer', 'Daily Cleanup of Temporary Directories', 'waiting'],
];

function globMatch(pattern, name) {
  const source = String(pattern)
    .replace(/[.+^${}()|\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`).test(name);
}

/** `-x` catalog explanation lines for a journal entry. */
function catalogLines(catalog) {
  const support = [
    '░░ Defined-By: systemd',
    '░░ Support: https://access.redhat.com/support',
    '░░ ',
  ];
  switch (catalog.type) {
    case 'start-begin':
      return [
        `░░ Subject: A start job for unit ${catalog.unit} has begun execution`,
        ...support,
        `░░ A start job for unit ${catalog.unit} has begun execution.`,
        '░░ ',
        `░░ The job identifier is ${catalog.job}.`,
      ];
    case 'start-done':
      return [
        `░░ Subject: A start job for unit ${catalog.unit} has finished successfully`,
        ...support,
        `░░ A start job for unit ${catalog.unit} has finished successfully.`,
        '░░ ',
        `░░ The job identifier is ${catalog.job}.`,
      ];
    case 'start-failed':
      return [
        `░░ Subject: A start job for unit ${catalog.unit} has failed`,
        ...support,
        `░░ A start job for unit ${catalog.unit} has finished with a failure.`,
        '░░ ',
        `░░ The job identifier is ${catalog.job} and the job result is failed.`,
      ];
    case 'unit-failed':
      return [
        '░░ Subject: Unit failed',
        ...support,
        `░░ The unit ${catalog.unit} has entered the 'failed' state with result '${catalog.result}'.`,
      ];
    case 'process-exited':
      return [
        '░░ Subject: Unit process exited',
        ...support,
        `░░ An ExecStart= process belonging to unit ${catalog.unit} has exited.`,
        '░░ ',
        `░░ The process' exit code is '${catalog.code}' and its exit status is ${catalog.status}.`,
      ];
    case 'stop-begin':
      return [
        `░░ Subject: A stop job for unit ${catalog.unit} has begun execution`,
        ...support,
        `░░ A stop job for unit ${catalog.unit} has begun execution.`,
        '░░ ',
        `░░ The job identifier is ${catalog.job}.`,
      ];
    case 'stop-done':
      return [
        `░░ Subject: A stop job for unit ${catalog.unit} has finished`,
        ...support,
        `░░ A stop job for unit ${catalog.unit} has finished.`,
        '░░ ',
        `░░ The job identifier is ${catalog.job} and the job result is done.`,
      ];
    case 'unit-succeeded':
      return [
        '░░ Subject: Unit succeeded',
        ...support,
        `░░ The unit ${catalog.unit} has successfully entered the 'dead' state.`,
      ];
    default:
      return [];
  }
}

/** journalctl --since/--until: today, yesterday, now, "N min ago", -5min, YYYY-MM-DD [HH:MM[:SS]], HH:MM. */
function parseJournalTime(text, now) {
  const value = text.trim().toLowerCase();
  const day = new Date(now);
  const midnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  if (value === 'today') return midnight;
  if (value === 'yesterday') return midnight - 86400000;
  if (value === 'now') return now;
  if (value === 'tomorrow') return midnight + 86400000;
  const relative = value.match(
    /^-?(\d+)\s*(s|sec|second|seconds|m|min|minute|minutes|h|hour|hours|d|day|days)(\s+ago)?$/
  );
  if (relative) {
    const unit = relative[2].startsWith('s')
      ? 1000
      : relative[2].startsWith('h')
        ? 3600000
        : relative[2].startsWith('d')
          ? 86400000
          : 60000;
    return now - Number(relative[1]) * unit;
  }
  const full = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (full)
    return Date.UTC(
      Number(full[1]),
      Number(full[2]) - 1,
      Number(full[3]),
      Number(full[4] || 0),
      Number(full[5] || 0),
      Number(full[6] || 0)
    );
  const clock = value.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (clock)
    return (
      midnight +
      Number(clock[1]) * 3600000 +
      Number(clock[2]) * 60000 +
      Number(clock[3] || 0) * 1000
    );
  return null;
}

/** RHEL /etc/profile.d aliases the interactive shell has. */
const SHELL_ALIASES = {
  egrep: 'egrep --color=auto',
  fgrep: 'fgrep --color=auto',
  grep: 'grep --color=auto',
  'l.': 'ls -d .* --color=auto',
  ll: 'ls -l --color=auto',
  ls: 'ls --color=auto',
  xzegrep: 'xzegrep --color=auto',
  xzfgrep: 'xzfgrep --color=auto',
  xzgrep: 'xzgrep --color=auto',
  zegrep: 'zegrep --color=auto',
  zfgrep: 'zfgrep --color=auto',
  zgrep: 'zgrep --color=auto',
};

/** Short manual pages: [section, one-line summary, synopsis lines]. */
const MAN_PAGES = {
  ls: [1, 'list directory contents', ['ls [OPTION]... [FILE]...']],
  cd: [1, 'change the shell working directory (bash builtin)', ['cd [-L|[-P [-e]] [-@]] [dir]']],
  cp: [
    1,
    'copy files and directories',
    ['cp [OPTION]... [-T] SOURCE DEST', 'cp [OPTION]... SOURCE... DIRECTORY'],
  ],
  mv: [
    1,
    'move (rename) files',
    ['mv [OPTION]... [-T] SOURCE DEST', 'mv [OPTION]... SOURCE... DIRECTORY'],
  ],
  rm: [1, 'remove files or directories', ['rm [OPTION]... [FILE]...']],
  mkdir: [1, 'make directories', ['mkdir [OPTION]... DIRECTORY...']],
  chmod: [
    1,
    'change file mode bits',
    ['chmod [OPTION]... MODE[,MODE]... FILE...', 'chmod [OPTION]... OCTAL-MODE FILE...'],
  ],
  chown: [1, 'change file owner and group', ['chown [OPTION]... [OWNER][:[GROUP]] FILE...']],
  grep: [1, 'print lines that match patterns', ['grep [OPTION...] PATTERNS [FILE...]']],
  find: [
    1,
    'search for files in a directory hierarchy',
    ['find [-H] [-L] [-P] [-D debugopts] [-Olevel] [starting-point...] [expression]'],
  ],
  tar: [1, 'an archiving utility', ['tar [OPTION...] [FILE]...']],
  ps: [1, 'report a snapshot of the current processes.', ['ps [options]']],
  kill: [1, 'send a signal to a process', ['kill [options] <pid> [...]']],
  top: [
    1,
    'display Linux processes',
    ['top -hv|-bcEeHiOSs1 -d secs -n max -u|U user -p pids -o field -w [cols]'],
  ],
  systemctl: [
    1,
    'Control the systemd system and service manager',
    ['systemctl [OPTIONS...] COMMAND [UNIT...]'],
  ],
  journalctl: [
    1,
    'Print log entries from the systemd journal',
    ['journalctl [OPTIONS...] [MATCHES...]'],
  ],
  'firewall-cmd': [1, 'firewalld command line client', ['firewall-cmd [OPTIONS...]']],
  dnf: [8, 'DNF Command Reference', ['dnf [options] <command> [<args>...]']],
  rpm: [8, 'RPM Package Manager', ['rpm {-q|--query} [select-options] [query-options]']],
  podman: [
    1,
    'Simple management tool for pods, containers and images',
    ['podman [options] command'],
  ],
  ip: [
    8,
    'show / manipulate routing, network devices, interfaces and tunnels',
    ['ip [ OPTIONS ] OBJECT { COMMAND | help }'],
  ],
  ss: [8, 'another utility to investigate sockets', ['ss [options] [ FILTER ]']],
  sudo: [
    8,
    'execute a command as another user',
    [
      'sudo [-AbEHnPS] [-C num] [-D directory] [-g group] [-h host] [-p prompt] [-R directory] [-r role] [-t type] [-T timeout] [-u user] [VAR=value] [-i | -s] [command [arg ...]]',
    ],
  ],
  restorecon: [
    8,
    'restore file(s) default SELinux security contexts.',
    ['restorecon [-r|-R] [-m] [-n] [-p] [-v] [-i] [-F] [-W] [-I|-D] [-e directory] pathname ...'],
  ],
  semanage: [
    8,
    'SELinux Policy Management tool',
    [
      'semanage {import,export,login,user,port,ibpkey,ibendport,interface,module,node,fcontext,boolean,permissive,dontaudit} ...',
    ],
  ],
  man: [
    1,
    'an interface to the system reference manuals',
    ['man [man options] [[section] page ...] ...'],
  ],
  oc: [1, 'OpenShift command line interface', ['oc [flags] [options] <command>']],
};

function parseSignal(text) {
  const raw = String(text ?? '')
    .toUpperCase()
    .replace(/^SIG/, '');
  if (/^\d+$/.test(raw)) return Number(raw) >= 0 && Number(raw) <= 64 ? Number(raw) : null;
  for (const [number, name] of Object.entries(SIGNAL_NAMES))
    if (name === raw) return Number(number);
  return null;
}

function killList() {
  const names = {
    ...Object.fromEntries(Object.entries(SIGNAL_NAMES).map(([n, s]) => [n, `SIG${s}`])),
  };
  for (let n = 34; n <= 64; n += 1) {
    names[n] =
      n <= 49
        ? n === 34
          ? 'SIGRTMIN'
          : `SIGRTMIN+${n - 34}`
        : n === 64
          ? 'SIGRTMAX'
          : `SIGRTMAX-${64 - n}`;
  }
  const entries = Object.entries(names).sort((a, b) => Number(a[0]) - Number(b[0]));
  const lines = [];
  for (let index = 0; index < entries.length; index += 5) {
    lines.push(
      entries
        .slice(index, index + 5)
        .map(([n, s]) => `${String(n).padStart(2)}) ${s}`)
        .join('\t')
    );
  }
  return lines.join('\n');
}

/** semanage port list formatting: `80, 81, 443, 8008-8009`. */
function compressPorts(ports) {
  const sorted = [...new Set(ports)].sort((a, b) => a - b);
  const out = [];
  for (let index = 0; index < sorted.length; index += 1) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end += 1;
    out.push(
      end - index >= 2 ? `${sorted[index]}-${sorted[end]}` : sorted.slice(index, end + 1).join(', ')
    );
    index = end;
  }
  return out.join(', ');
}

/** `file(1)` classification of text content (file 5.39 wording). */
function describeContent(content) {
  const text = String(content ?? '');
  if (!text.length) return 'empty';
  if (text.startsWith('\u001f\u008b'))
    return 'gzip compressed data, from Unix, original size modulo 2^32 10240';
  if (text.startsWith('\u007fELF'))
    return 'ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, stripped';
  const crlf = /\r\n/.test(text) ? ', with CRLF line terminators' : '';
  // eslint-disable-next-line no-control-regex
  const charset = /[^\u0000-\u007f]/.test(text) ? 'Unicode text, UTF-8 text' : 'ASCII text';
  const shebang = text.match(/^#!\s*(\S+)/);
  if (shebang) {
    const interpreter = basenameOf(shebang[1]);
    if (/bash/.test(interpreter)) return `Bourne-Again shell script, ${charset} executable${crlf}`;
    if (/sh$/.test(interpreter)) return `POSIX shell script, ${charset} executable${crlf}`;
    if (/python/.test(interpreter)) return `Python script, ${charset} executable${crlf}`;
    return `a ${shebang[1]} script, ${charset} executable${crlf}`;
  }
  if (/^\s*<\?xml/.test(text)) return `XML 1.0 document, ${charset}${crlf}`;
  if (/^\s*<!doctype html|^\s*<html/i.test(text)) return `HTML document, ${charset}${crlf}`;
  if (/^\s*[[{]/.test(text)) {
    try {
      JSON.parse(text);
      return 'JSON data';
    } catch {
      /* not JSON */
    }
  }
  if (/-----BEGIN CERTIFICATE-----/.test(text)) return 'PEM certificate';
  if (/-----BEGIN (RSA )?PRIVATE KEY-----/.test(text)) return 'OpenSSH private key';
  const lines = text.split('\n');
  const longest = Math.max(...lines.map((line) => line.length));
  const long = longest > 300 ? `, with very long lines (${longest})` : '';
  const noEol = text.endsWith('\n') ? '' : ', with no line terminators';
  return `${charset}${long}${crlf}${lines.length === 1 ? noEol : ''}`;
}

/** Glob → RegExp for find -name/-path. */
function globRegex(pattern, ignoreCase = false, fullPath = false) {
  let source = '';
  for (const char of String(pattern)) {
    if (char === '*') source += fullPath ? '.*' : '[^/]*';
    else if (char === '?') source += '.';
    else source += char.replace(/[.+^${}()|\\/]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, ignoreCase ? 'i' : '');
}

/** printf(1) format engine: %s %d %i %f %x %o %c %b %%, widths/precision, escapes. */
function formatPrintf(format, values) {
  const escapes = (text) =>
    String(text).replace(/\\(0[0-7]{0,3}|x[0-9a-fA-F]{1,2}|[abfnrtv\\"'])/g, (match, code) => {
      if (code[0] === '0') return String.fromCharCode(Number.parseInt(code.slice(1) || '0', 8));
      if (code[0] === 'x') return String.fromCharCode(Number.parseInt(code.slice(1), 16));
      return {
        a: '\u0007',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
        v: '\v',
        '\\': '\\',
        '"': '"',
        "'": "'",
      }[code];
    });
  const spec = /%([-+ 0#]*)(\d+|\*)?(?:\.(\d+))?([sdifxXocbeEgG%])/g;
  let output = '';
  let index = 0;
  let consumed = true;
  do {
    consumed = false;
    output += escapes(String(format)).replace(
      spec,
      (match, flagText, width, precision, conversion) => {
        if (conversion === '%') return '%';
        consumed = true;
        const raw = values[index++];
        let text;
        if (conversion === 's') text = raw ?? '';
        else if (conversion === 'b') text = escapes(raw ?? '');
        else if (conversion === 'c') text = String(raw ?? '').charAt(0);
        else if ('di'.includes(conversion)) text = String(Math.trunc(Number(raw ?? 0)) || 0);
        else if ('xX'.includes(conversion))
          text = (Math.trunc(Number(raw ?? 0)) || 0)
            .toString(16)
            [conversion === 'X' ? 'toUpperCase' : 'toLowerCase']();
        else if (conversion === 'o') text = (Math.trunc(Number(raw ?? 0)) || 0).toString(8);
        else
          text = (Number(raw ?? 0) || 0).toFixed(precision !== undefined ? Number(precision) : 6);
        if (conversion === 's' && precision !== undefined) text = text.slice(0, Number(precision));
        const size = width && width !== '*' ? Number(width) : 0;
        if (text.length < size) {
          if (flagText.includes('-')) text = text.padEnd(size);
          else if (flagText.includes('0') && conversion !== 's') text = text.padStart(size, '0');
          else text = text.padStart(size);
        }
        return text;
      }
    );
  } while (consumed && index < values.length);
  return output;
}

/** Line diff (LCS): normal `diff` output or unified (`-u`) hunks. */
function diffLines(
  leftText,
  rightText,
  { unified = false, leftLabel = 'a', rightLabel = 'b' } = {}
) {
  const split = (text) => {
    const lines = String(text).split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const a = split(leftText);
  const b = split(rightText);
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ type: '=', left: i, right: j });
      i += 1;
      j += 1;
    } else if (j < b.length && (i >= a.length || table[i][j + 1] >= table[i + 1][j])) {
      ops.push({ type: '+', left: i, right: j });
      j += 1;
    } else {
      ops.push({ type: '-', left: i, right: j });
      i += 1;
    }
  }
  if (unified) {
    const out = [`--- ${leftLabel}`, `+++ ${rightLabel}`];
    const changes = ops
      .map((op, index) => (op.type !== '=' ? index : -1))
      .filter((index) => index >= 0);
    let cursor = 0;
    while (cursor < changes.length) {
      let start = Math.max(0, changes[cursor] - 3);
      let end = changes[cursor];
      while (cursor + 1 < changes.length && changes[cursor + 1] - end <= 7) {
        cursor += 1;
        end = changes[cursor];
      }
      end = Math.min(ops.length - 1, end + 3);
      const hunk = ops.slice(start, end + 1);
      const leftStart = hunk.find((op) => op.type !== '+')?.left ?? hunk[0].left;
      const rightStart = hunk.find((op) => op.type !== '-')?.right ?? hunk[0].right;
      const leftCount = hunk.filter((op) => op.type !== '+').length;
      const rightCount = hunk.filter((op) => op.type !== '-').length;
      out.push(
        `@@ -${leftCount ? leftStart + 1 : leftStart},${leftCount} +${rightCount ? rightStart + 1 : rightStart},${rightCount} @@`
      );
      for (const op of hunk) {
        if (op.type === '=') out.push(` ${a[op.left]}`);
        else if (op.type === '-') out.push(`-${a[op.left]}`);
        else out.push(`+${b[op.right]}`);
      }
      cursor += 1;
      start = end;
    }
    return out.join('\n');
  }
  const out = [];
  let index = 0;
  while (index < ops.length) {
    if (ops[index].type === '=') {
      index += 1;
      continue;
    }
    const block = [];
    while (index < ops.length && ops[index].type !== '=') block.push(ops[index++]);
    const removed = block.filter((op) => op.type === '-');
    const added = block.filter((op) => op.type === '+');
    const range = (from, count) => (count <= 1 ? String(from + 1) : `${from + 1},${from + count}`);
    if (removed.length && added.length) {
      out.push(`${range(removed[0].left, removed.length)}c${range(added[0].right, added.length)}`);
      out.push(
        ...removed.map((op) => `< ${a[op.left]}`),
        '---',
        ...added.map((op) => `> ${b[op.right]}`)
      );
    } else if (removed.length) {
      out.push(`${range(removed[0].left, removed.length)}d${added.length ? '' : block[0].right}`);
      out.push(...removed.map((op) => `< ${a[op.left]}`));
    } else {
      out.push(`${block[0].left}a${range(added[0].right, added.length)}`);
      out.push(...added.map((op) => `> ${b[op.right]}`));
    }
  }
  return out.join('\n');
}
