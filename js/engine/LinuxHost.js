/**
 * LinuxHost — the simulated RHEL 9.6 workstation (`workstation.lab.example.com`) behind the
 * shifting.pro terminal (1.16.0, "Linux & RHEL Foundations" prelude).
 *
 * The terminal has always been a workstation shell: `oc`, `cat`, `vim`, heredocs and redirects
 * run "on" it. This module is that machine, so Linux commands behave like RHEL 9:
 *
 *  - a filesystem tree (type, mode, owner, group, size, mtime, SELinux context, symlinks). The
 *    FILE CONTENTS of `/home/student/**` and `/tmp/**` stay in the ManifestEngine virtual
 *    filesystem (the Files panel, `oc apply -f`), keyed relative to the home directory exactly
 *    like before (`/tmp/x` ⇔ key `tmp/x`); this module keeps a metadata overlay for them
 *    (mode/owner/context, empty directories, host-only dotfiles);
 *  - users/groups (`/etc/passwd`, `/etc/group`, `/etc/shadow` are rendered from the model);
 *  - processes, systemd units + the journal, dnf/rpm packages, the network (interfaces, routes,
 *    `/etc/hosts` + lab DNS, listening sockets), firewalld (runtime vs permanent), SELinux and
 *    rootless podman.
 *
 * Shell commands live in js/ui/ShellTools.js + js/ui/LinuxCommands.js and only call this API;
 * ObjectiveEvaluator's Linux objective types read the query API at the end of the class.
 * The module is DOM-free and deterministic for a given seed (only the wall clock moves; tests
 * inject `clock`). Seed schema: /tmp/osg-team/LINUX-SCHEMA.md (mirrored in `reset()` docs).
 */

import { OCP_VERSION } from '../data/platformVersions.js';

// ─── identity of the machine ────────────────────────────────────────────────

export const HOME = '/home/student';
export const HOSTNAME_FQDN = 'workstation.lab.example.com';
export const HOSTNAME_SHORT = 'workstation';
export const RHEL_VERSION = '9.6';
export const RHEL_PRETTY_NAME = 'Red Hat Enterprise Linux 9.6 (Plow)';
export const KERNEL_RELEASE = '5.14.0-570.12.1.el9_6.x86_64';
export const KERNEL_VERSION = '#1 SMP PREEMPT_DYNAMIC Fri Apr 11 10:42:16 EDT 2025';
export const WORKSTATION_IP = '172.25.250.9';
export const GATEWAY_IP = '172.25.250.254';
export const DNS_SERVER_IP = '172.25.250.254';
export const WORKSTATION_MAC = '52:54:00:00:fa:09';
/** The game cluster (CommandBar OC_SERVER_URL / APPS_DOMAIN) and its lab VIPs. */
export const CLUSTER_DOMAIN = 'cluster.example.com';
export const APPS_DOMAIN = `apps.${CLUSTER_DOMAIN}`;
export const API_VIP = '192.168.50.10';
export const INGRESS_VIP = '192.168.50.11';
/** The simulated internet host answered by the workstation curl (ShellTools #49). */
const EXAMPLE_COM_IP = '93.184.216.34';

const MEMORY_TOTAL_KIB = 3714968;
const CPU_COUNT = 2;
/** Uptime at reset: the machine booted this long before the level started. */
const BOOT_AGE_MS = (5 * 3600 + 12 * 60 + 9) * 1000;
/** When the default files were installed (anaconda) — old enough for `ls -l` to show a year. */
const INSTALL_TIME_MS = Date.UTC(2025, 7, 4, 10, 12, 33);

/** errno names → strerror(3) text (glibc, en_US). */
export const ERRNO_TEXT = {
  ENOENT: 'No such file or directory',
  EACCES: 'Permission denied',
  EPERM: 'Operation not permitted',
  EISDIR: 'Is a directory',
  ENOTDIR: 'Not a directory',
  EEXIST: 'File exists',
  ENOTEMPTY: 'Directory not empty',
  ELOOP: 'Too many levels of symbolic links',
  EINVAL: 'Invalid argument',
  EBUSY: 'Device or resource busy',
  EROFS: 'Read-only file system',
  EXDEV: 'Invalid cross-device link',
};

export function errnoText(code) {
  return ERRNO_TEXT[code] || String(code || 'Unknown error');
}

// ─── small pure helpers ─────────────────────────────────────────────────────

/** Collapse `.`, `..` and duplicate slashes of an absolute path (`/a/./b/../c` → `/a/c`). */
export function normalizePath(path) {
  const parts = [];
  for (const part of String(path ?? '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

export function dirnameOf(path) {
  const abs = normalizePath(path);
  if (abs === '/') return '/';
  const index = abs.lastIndexOf('/');
  return index <= 0 ? '/' : abs.slice(0, index);
}

export function basenameOf(path) {
  const abs = normalizePath(path);
  if (abs === '/') return '/';
  return abs.slice(abs.lastIndexOf('/') + 1);
}

function isUnder(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

/** UTF-8 byte length (file sizes are bytes, not UTF-16 code units). */
export function byteLength(text) {
  const value = String(text ?? '');
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).length;
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** FNV-1a 32-bit. */
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  const value = String(text ?? '');
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 64 hex chars of a fake sha256 — the SAME algorithm as ClusterState._fakeDigest, so an image
 * digest on the workstation (podman/skopeo) equals the one the simulated cluster reports for
 * the same canonical reference.
 */
export function fakeSha256(seed) {
  let state = fnv1a(seed) || 0x9e3779b9;
  let out = '';
  for (let index = 0; index < 8; index += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out += state.toString(16).padStart(8, '0');
  }
  return out;
}

/** `-rw-r--r--` / `drwxrwxrwt` / `-rwsr-xr-x` from a node type and permission bits. */
export function modeString(type, mode) {
  const typeChar =
    { dir: 'd', link: 'l', char: 'c', block: 'b', fifo: 'p', socket: 's' }[type] || '-';
  const bit = (mask, char) => (mode & mask ? char : '-');
  const special = (execMask, specialMask, setChar) => {
    const exec = Boolean(mode & execMask);
    if (!(mode & specialMask)) return exec ? 'x' : '-';
    return exec ? setChar : setChar.toUpperCase();
  };
  return (
    typeChar +
    bit(0o400, 'r') +
    bit(0o200, 'w') +
    special(0o100, 0o4000, 's') +
    bit(0o040, 'r') +
    bit(0o020, 'w') +
    special(0o010, 0o2000, 's') +
    bit(0o004, 'r') +
    bit(0o002, 'w') +
    special(0o001, 0o1000, 't')
  );
}

/** `0644` (4 digits, like `stat -c %a` padded) */
export function octalMode(mode) {
  return (mode & 0o7777).toString(8).padStart(4, '0');
}

/**
 * Apply a chmod mode operand (`755`, `0640`, `u+x`, `go-rw`, `a=r,u+w`, `+x`, `g+s`, `o+t`,
 * `u+X`). Returns the new permission bits or null for an invalid operand. Without a `who`
 * the umask limits the bits like GNU chmod.
 */
export function applyChmod(spec, currentMode, { isDir = false, umask = 0o022 } = {}) {
  const text = String(spec ?? '').trim();
  if (/^[0-7]{1,4}$/.test(text)) {
    const value = Number.parseInt(text, 8);
    // GNU chmod keeps the directory setuid/setgid bits for short octal operands.
    if (isDir && text.length <= 3) return (currentMode & 0o6000) | value;
    return value;
  }
  let mode = currentMode & 0o7777;
  for (const clause of text.split(',')) {
    const match = clause.match(/^([ugoa]*)((?:[-+=][rwxXstugo]*)+)$/);
    if (!match) return null;
    const who = match[1] || '';
    const ops = match[2].match(/[-+=][rwxXstugo]*/g) || [];
    const targets = who === '' ? 'a' : who.replace(/a/g, 'ugo');
    const whoMask = { u: 0o4700, g: 0o2070, o: 0o1007 };
    let mask = 0;
    for (const target of targets === 'a' ? 'ugo' : targets) mask |= whoMask[target];
    for (const op of ops) {
      const operator = op[0];
      const perms = op.slice(1);
      let bits = 0;
      for (const perm of perms) {
        if (perm === 'r') bits |= 0o444;
        else if (perm === 'w') bits |= 0o222;
        else if (perm === 'x') bits |= 0o111;
        else if (perm === 'X') {
          if (isDir || mode & 0o111) bits |= 0o111;
        } else if (perm === 's') bits |= 0o6000;
        else if (perm === 't') bits |= 0o1000;
        else if ('ugo'.includes(perm)) {
          const shift = { u: 6, g: 3, o: 0 }[perm];
          const source = (mode >> shift) & 7;
          bits |= (source << 6) | (source << 3) | source;
        }
      }
      let effective = bits & mask;
      if (who === '') effective &= ~umask | 0o7000;
      if (operator === '+') mode |= effective;
      else if (operator === '-') mode &= ~effective;
      else {
        const clear = mask & (who === '' ? 0o0777 : 0o7777);
        mode = (mode & ~clear) | effective;
      }
    }
  }
  return mode & 0o7777;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad2 = (value) => String(value).padStart(2, '0');

/** All machine times are UTC (`timedatectl`: Time zone: UTC). */
export function clockParts(ms) {
  const date = new Date(ms);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
    hours: date.getUTCHours(),
    minutes: date.getUTCMinutes(),
    seconds: date.getUTCSeconds(),
    millis: date.getUTCMilliseconds(),
  };
}

/** `ls -l` time column: `Nov  8 14:16` (< 6 months old) or `Aug  4  2025`. */
export function formatLsTime(ms, now) {
  const parts = clockParts(ms);
  const head = `${MONTHS[parts.month]} ${String(parts.day).padStart(2, ' ')}`;
  const sixMonths = 182.5 * 24 * 3600 * 1000;
  if (now - ms > sixMonths || ms - now > 3600 * 1000) return `${head}  ${parts.year}`;
  return `${head} ${pad2(parts.hours)}:${pad2(parts.minutes)}`;
}

/** journalctl short format: `Nov 08 14:16:39`. */
export function formatJournalTime(ms) {
  const parts = clockParts(ms);
  return `${MONTHS[parts.month]} ${pad2(parts.day)} ${pad2(parts.hours)}:${pad2(parts.minutes)}:${pad2(parts.seconds)}`;
}

/** syslog (/var/log/messages) format: `Nov  8 14:16:39`. */
export function formatSyslogTime(ms) {
  const parts = clockParts(ms);
  return `${MONTHS[parts.month]} ${String(parts.day).padStart(2, ' ')} ${pad2(parts.hours)}:${pad2(parts.minutes)}:${pad2(parts.seconds)}`;
}

/** systemd timestamp: `Sun 2026-11-08 14:10:02 UTC`. */
export function formatSystemdTime(ms) {
  const parts = clockParts(ms);
  return `${DAYS[parts.weekday]} ${parts.year}-${pad2(parts.month + 1)}-${pad2(parts.day)} ${pad2(parts.hours)}:${pad2(parts.minutes)}:${pad2(parts.seconds)} UTC`;
}

/** `date` default output: `Sun Nov  8 14:16:39 UTC 2026`. */
export function formatDate(ms) {
  const parts = clockParts(ms);
  return `${DAYS[parts.weekday]} ${MONTHS[parts.month]} ${String(parts.day).padStart(2, ' ')} ${pad2(parts.hours)}:${pad2(parts.minutes)}:${pad2(parts.seconds)} UTC ${parts.year}`;
}

/** dnf/rpm locale date: `Sun 08 Nov 2026 02:21:13 PM UTC`. */
export function formatRpmTime(ms) {
  const parts = clockParts(ms);
  const hour12 = parts.hours % 12 === 0 ? 12 : parts.hours % 12;
  const meridiem = parts.hours < 12 ? 'AM' : 'PM';
  return `${DAYS[parts.weekday]} ${pad2(parts.day)} ${MONTHS[parts.month]} ${parts.year} ${pad2(hour12)}:${pad2(parts.minutes)}:${pad2(parts.seconds)} ${meridiem} UTC`;
}

/** `stat` timestamp: `2026-11-08 14:16:39.123456789 +0000`. */
export function formatStatTime(ms) {
  const parts = clockParts(ms);
  const nanos = `${String(parts.millis).padStart(3, '0')}${String(fnv1a(ms) % 1000000).padStart(6, '0')}`;
  return `${parts.year}-${pad2(parts.month + 1)}-${pad2(parts.day)} ${pad2(parts.hours)}:${pad2(parts.minutes)}:${pad2(parts.seconds)}.${nanos} +0000`;
}

/** `HH:MM` (ps START / STIME). */
export function formatClock(ms) {
  const parts = clockParts(ms);
  return `${pad2(parts.hours)}:${pad2(parts.minutes)}`;
}

/** systemd's format_timestamp_relative(): `6min ago`, `1h 5min ago`, `2 days ago`. */
export function formatRelative(ms, now) {
  let seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds <= 0) return 'now';
  const day = 86400;
  if (seconds >= 2 * day) return `${Math.floor(seconds / day)} days ago`;
  if (seconds >= 25 * 3600) return `1 day ${Math.floor((seconds - day) / 3600)}h ago`;
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes ? `${hours}h ${minutes}min ago` : `${hours}h ago`;
  }
  if (seconds >= 300) return `${Math.floor(seconds / 60)}min ago`;
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    seconds %= 60;
    return seconds ? `${minutes}min ${seconds}s ago` : `${minutes}min ago`;
  }
  return `${seconds}s ago`;
}

/** `ls -lh` / `du -h` / `df -h` human sizes (1024 based, one decimal under 10). */
export function humanSize(bytes, { suffixB = false } = {}) {
  const units = ['K', 'M', 'G', 'T'];
  let value = Number(bytes) || 0;
  if (value < 1024) return suffixB ? `${value}B` : String(value);
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // GNU rounds up; a value that reaches 10 after rounding drops the decimal (`10G`).
  const tenths = Math.ceil(value * 10) / 10;
  const text = tenths < 10 ? tenths.toFixed(1) : String(Math.ceil(value));
  return `${text}${units[unit]}`;
}

/** Glob (`*`, `?`, `[abc]`, `[!a]`) → RegExp for one path segment. */
export function globToRegExp(glob) {
  let source = '';
  const text = String(glob ?? '');
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '[') {
      const close = text.indexOf(']', index + 2);
      if (close < 0) {
        source += '\\[';
        continue;
      }
      let body = text.slice(index + 1, close);
      if (body.startsWith('!') || body.startsWith('^')) body = `^${body.slice(1)}`;
      source += `[${body.replace(/\\/g, '\\\\')}]`;
      index = close;
    } else source += char.replace(/[.+^${}()|\\/]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

export function hasGlobChars(text) {
  return /[*?[]/.test(String(text ?? ''));
}

/**
 * glibc en_US.UTF-8-like collation for `ls`/`sort` order: punctuation (leading dots) is
 * ignored at the first level and letters compare case-insensitively.
 */
export function collateNames(left, right) {
  const key = (value) =>
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const a = key(left);
  const b = key(right);
  if (a !== b) return a < b ? -1 : 1;
  return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
}

// ─── default system content ─────────────────────────────────────────────────

export const OS_RELEASE = [
  'NAME="Red Hat Enterprise Linux"',
  'VERSION="9.6 (Plow)"',
  'ID="rhel"',
  'ID_LIKE="fedora"',
  'VERSION_ID="9.6"',
  'PLATFORM_ID="platform:el9"',
  'PRETTY_NAME="Red Hat Enterprise Linux 9.6 (Plow)"',
  'ANSI_COLOR="0;31"',
  'LOGO="fedora-logo-icon"',
  'CPE_NAME="cpe:/o:redhat:enterprise_linux:9::baseos"',
  'HOME_URL="https://www.redhat.com/"',
  'DOCUMENTATION_URL="https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9"',
  'BUG_REPORT_URL="https://issues.redhat.com/"',
  '',
  'REDHAT_BUGZILLA_PRODUCT="Red Hat Enterprise Linux 9"',
  'REDHAT_BUGZILLA_PRODUCT_VERSION=9.6',
  'REDHAT_SUPPORT_PRODUCT="Red Hat Enterprise Linux"',
  'REDHAT_SUPPORT_PRODUCT_VERSION="9.6"',
  '',
].join('\n');

/** RHEL 9 /etc/skel/.bashrc (a real login shell already has ~/bin on PATH). */
export const SKEL_BASHRC = `# .bashrc

# Source global definitions
if [ -f /etc/bashrc ]; then
	. /etc/bashrc
fi

# User specific environment
if ! [[ "$PATH" =~ "$HOME/.local/bin:$HOME/bin:" ]]
then
    PATH="$HOME/.local/bin:$HOME/bin:$PATH"
fi
export PATH

# Uncomment the following line if you don't like systemctl's auto-paging feature:
# export SYSTEMD_PAGER=

# User specific aliases and functions
if [ -d ~/.bashrc.d ]; then
	for rc in ~/.bashrc.d/*; do
		if [ -f "$rc" ]; then
			. "$rc"
		fi
	done
fi

unset rc
`;

const SKEL_BASH_PROFILE = `# .bash_profile

# Get the aliases and functions
if [ -f ~/.bashrc ]; then
	. ~/.bashrc
fi

# User specific environment and startup programs
`;

const SKEL_BASH_LOGOUT = '# ~/.bash_logout\n';

const ETC_BASHRC = `# /etc/bashrc

# System wide functions and aliases
# Environment stuff goes in /etc/profile

# It's NOT a good idea to change this file unless you know what you
# are doing. It's much better to create a custom.sh shell script in
# /etc/profile.d/ to make custom changes to your environment, as this
# will prevent the need for merging in future updates.

# Prevent doublesourcing
if [ -z "$BASHRCSOURCED" ]; then
  BASHRCSOURCED="Y"

  # are we an interactive shell?
  if [ "$PS1" ]; then
    if [ -z "$PROMPT_COMMAND" ]; then
      PROMPT_COMMAND='printf "\\033]0;%s@%s:%s\\007" "\${USER}" "\${HOSTNAME%%.*}" "\${PWD/#$HOME/\\~}"'
    fi
    # Turn on parallel history
    shopt -s histappend
    # Turn on checkwinsize
    shopt -s checkwinsize
    [ "$PS1" = "\\\\s-\\\\v\\\\\\$ " ] && PS1="[\\u@\\h \\W]\\\\$ "
  fi

  # Set default umask for non-login shell only if it is set to 0
  [ \`umask\` -eq 0 ] && umask 022
fi
# vim:ts=4:sw=4
`;

const ETC_HOSTS = `127.0.0.1   localhost localhost.localdomain localhost4 localhost4.localdomain4
::1         localhost localhost.localdomain localhost6 localhost6.localdomain6

172.25.254.254  classroom.example.com classroom
172.25.250.9    workstation.lab.example.com workstation
`;

const ETC_RESOLV = `# Generated by NetworkManager
search lab.example.com
nameserver ${DNS_SERVER_IP}
`;

const ETC_NSSWITCH = `# Generated by authselect
# Do not modify this file manually, use authselect instead. Any user changes will be lost.
# You can stop authselect from managing your configuration by calling 'authselect opt-out'.
# See authselect(8) for more details.

# In order of likelihood of use to accelerate lookup.
passwd:     files sss systemd
shadow:     files
group:      files sss systemd
hosts:      files dns myhostname
services:   files sss
netgroup:   files sss
automount:  files sss

aliases:    files
ethers:     files
gshadow:    files
networks:   files dns
protocols:  files
publickey:  files
rpc:        files
`;

const SELINUX_CONFIG = (mode) => `
# This file controls the state of SELinux on the system.
# SELINUX= can take one of these three values:
#     enforcing - SELinux security policy is enforced.
#     permissive - SELinux prints warnings instead of enforcing.
#     disabled - No SELinux policy is loaded.
# See also:
# https://docs.fedoraproject.org/en-US/quick-docs/getting-started-with-selinux/#getting-started-with-selinux-selinux-states-and-modes
#
# NOTE: In earlier Fedora kernel builds, SELINUX=disabled would also
# fully disable SELinux during boot. If you need a system with SELinux
# fully disabled instead of SELinux running with no policy loaded, you
# need to pass selinux=0 to the kernel command line. You can use grubby
# to persistently set the bootloader to boot with selinux=0:
#
#    grubby --update-kernel ALL --args selinux=0
#
# To revert back to SELinux enabled:
#
#    grubby --update-kernel ALL --remove-args selinux
#
SELINUX=${mode}
# SELINUXTYPE= can take one of these three values:
#     targeted - Targeted processes are protected,
#     minimum - Modification of targeted policy. Only selected processes are protected.
#     mls - Multi Level Security protection.
SELINUXTYPE=targeted


`;

const ETC_FSTAB = `
#
# /etc/fstab
# Created by anaconda on Mon Aug  4 10:12:33 2025
#
# Accessible filesystems, by reference, are maintained under '/dev/disk/'.
# See man pages fstab(5), findfs(8), mount(8) and/or blkid(8) for more info.
#
# After editing this file, run 'systemctl daemon-reload' to update systemd
# units generated from this file.
#
UUID=4f2a1c7e-1b9d-4c55-9a51-6d1f0e3b2a77 /                       xfs     defaults        0 0
UUID=7c0e3d5a-2f41-4b6e-8f2d-1a9b3c4d5e6f /boot                   xfs     defaults        0 0
UUID=3A1B-2C4D          /boot/efi               vfat    umask=0077,shortname=winnt 0 2
`;

const ETC_SUDOERS = `## Sudoers allows particular users to run various commands as
## the root user, without needing the root password.
##
## Examples are provided at the bottom of the file for collections
## of related commands, which can then be delegated out to particular
## users or groups.
##
## This file must be edited with the 'visudo' command.

Defaults   !visiblepw
Defaults    always_set_home
Defaults    match_group_by_gid
Defaults    always_query_group_plugin
Defaults    env_reset
Defaults    env_keep =  "COLORS DISPLAY HOSTNAME HISTSIZE KDEDIR LS_COLORS"
Defaults    secure_path = /sbin:/bin:/usr/sbin:/usr/bin

## Allow root to run any commands anywhere
root	ALL=(ALL) 	ALL

## Allows people in group wheel to run all commands
%wheel	ALL=(ALL)	ALL

## Read drop-in files from /etc/sudoers.d (the # here does not mean a comment)
#includedir /etc/sudoers.d
`;

const ETC_SSHD_CONFIG = `#	$OpenBSD: sshd_config,v 1.104 2021/07/02 05:11:21 dtucker Exp $

# This is the sshd server system-wide configuration file.  See
# sshd_config(5) for more information.

# To modify the system-wide sshd configuration, create a  *.conf  file under
#  /etc/ssh/sshd_config.d/  which will be automatically included below
Include /etc/ssh/sshd_config.d/*.conf

#Port 22
#AddressFamily any
#ListenAddress 0.0.0.0
#ListenAddress ::

#HostKey /etc/ssh/ssh_host_rsa_key
#HostKey /etc/ssh/ssh_host_ecdsa_key
#HostKey /etc/ssh/ssh_host_ed25519_key

# Logging
#SyslogFacility AUTH
#LogLevel INFO

# Authentication:

#LoginGraceTime 2m
#PermitRootLogin prohibit-password
#StrictModes yes
#MaxAuthTries 6
#MaxSessions 10

#PubkeyAuthentication yes

# The default is to check both .ssh/authorized_keys and .ssh/authorized_keys2
# but this is overridden so installations will only check .ssh/authorized_keys
AuthorizedKeysFile	.ssh/authorized_keys

# To disable tunneled clear text passwords, change to no here!
#PasswordAuthentication yes
#PermitEmptyPasswords no

#X11Forwarding no
#PrintMotd yes

# override default of no subsystems
Subsystem	sftp	/usr/libexec/openssh/sftp-server
`;

const ETC_CHRONY = `# Use the classroom NTP server.
server classroom.example.com iburst

# Use NTP servers from DHCP.
sourcedir /run/chrony-dhcp

# Record the rate at which the system clock gains/losses time.
driftfile /var/lib/chrony/drift

# Allow the system clock to be stepped in the first three updates
# if its offset is larger than 1 second.
makestep 1.0 3

# Enable kernel synchronization of the real-time clock (RTC).
rtcsync

# Get TAI-UTC offset and leap seconds from the system tz database.
leapsectz right/UTC

# Specify directory for log files.
logdir /var/log/chrony
`;

const ETC_CRONTAB = `SHELL=/bin/bash
PATH=/sbin:/bin:/usr/sbin:/usr/bin
MAILTO=root

# For details see man 4 crontabs

# Example of job definition:
# .---------------- minute (0 - 59)
# |  .------------- hour (0 - 23)
# |  |  .---------- day of month (1 - 31)
# |  |  |  .------- month (1 - 12) OR jan,feb,mar,apr ...
# |  |  |  |  .---- day of week (0 - 6) (Sunday=0 or 7) OR sun,mon,tue,wed,thu,fri,sat
# |  |  |  |  |
# *  *  *  *  * user-name  command to be executed

`;

const ETC_LOGIN_DEFS = `#
# Please note that the parameters in this configuration file control the
# behavior of the tools from the shadow-utils component. None of these
# tools uses the PAM mechanism, and the utilities that use PAM (such as the
# passwd command) should therefore be configured elsewhere. Refer to
# /etc/pam.d/system-auth for more information.
#

MAIL_DIR	/var/spool/mail

# Password aging controls:
PASS_MAX_DAYS	99999
PASS_MIN_DAYS	0
PASS_WARN_AGE	7

# Min/max values for automatic uid selection in useradd(8)
UID_MIN                  1000
UID_MAX                 60000
SYS_UID_MIN               201
SYS_UID_MAX               999

# Min/max values for automatic gid selection in groupadd(8)
GID_MIN                  1000
GID_MAX                 60000
SYS_GID_MIN               201
SYS_GID_MAX               999

CREATE_HOME	yes
UMASK		022
HOME_MODE	0700
USERGROUPS_ENAB yes
ENCRYPT_METHOD SHA512
`;

const ETC_REGISTRIES = `# For more information on this configuration file, see containers-registries.conf(5).
#
# An array of host[:port] registries to try when pulling an unqualified image, in order.
unqualified-search-registries = ["registry.access.redhat.com", "registry.redhat.io", "docker.io"]

# short-name-mode="enforcing"
`;

const ETC_FIREWALLD_CONF = `# firewalld config file

# default zone
# The default zone used if an empty zone string is used.
# Default: public
DefaultZone=public

# Clean up on exit
# If set to no or false the firewall configuration will not get cleaned up
# on exit or stop of firewalld.
# Default: yes
CleanupOnExit=yes

# Lockdown
# If set to enabled, firewall changes with the D-Bus interface will be limited
# to applications that are listed in the lockdown whitelist.
# Default: no
Lockdown=no

# IPv6_rpfilter
# Performs a reverse path filter test on a packet for IPv6. If a reply to the
# packet would be sent via the same interface that the packet arrived on, the
# packet will match and be accepted, otherwise dropped.
# Default: yes
IPv6_rpfilter=yes

# FirewallBackend
# Selects the firewall backend implementation.
# Choices are:
#	- nftables (default)
#	- iptables (iptables, ip6tables, ebtables and ipset)
# Default: nftables
FirewallBackend=nftables
`;

const REDHAT_REPO = (repos) =>
  repos
    .map(
      (repo) =>
        `[${repo.id}]\nname = ${repo.name}\nbaseurl = https://cdn.redhat.com/content/dist/rhel9/$releasever/x86_64/${repo.path}/os\nenabled = 1\ngpgcheck = 1\ngpgkey = file:///etc/pki/rpm-gpg/RPM-GPG-KEY-redhat-release\nsslverify = 1\nsslcacert = /etc/rhsm/ca/redhat-uep.pem\n`
    )
    .join('\n');

// ─── users / groups ─────────────────────────────────────────────────────────

/** [name, uid, gid, gecos, home, shell] — RHEL 9 base accounts + the lab user. */
const DEFAULT_USERS = [
  ['root', 0, 0, 'root', '/root', '/bin/bash'],
  ['bin', 1, 1, 'bin', '/bin', '/sbin/nologin'],
  ['daemon', 2, 2, 'daemon', '/sbin', '/sbin/nologin'],
  ['adm', 3, 4, 'adm', '/var/adm', '/sbin/nologin'],
  ['lp', 4, 7, 'lp', '/var/spool/lpd', '/sbin/nologin'],
  ['sync', 5, 0, 'sync', '/sbin', '/bin/sync'],
  ['shutdown', 6, 0, 'shutdown', '/sbin', '/sbin/shutdown'],
  ['halt', 7, 0, 'halt', '/sbin', '/sbin/halt'],
  ['mail', 8, 12, 'mail', '/var/spool/mail', '/sbin/nologin'],
  ['operator', 11, 0, 'operator', '/root', '/sbin/nologin'],
  ['games', 12, 100, 'games', '/usr/games', '/sbin/nologin'],
  ['ftp', 14, 50, 'FTP User', '/var/ftp', '/sbin/nologin'],
  ['nobody', 65534, 65534, 'Kernel Overflow User', '/', '/sbin/nologin'],
  ['dbus', 81, 81, 'System message bus', '/', '/sbin/nologin'],
  ['systemd-coredump', 999, 997, 'systemd Core Dumper', '/', '/sbin/nologin'],
  ['polkitd', 998, 996, 'User for polkitd', '/', '/sbin/nologin'],
  ['tss', 59, 59, 'Account used for TPM access', '/', '/usr/sbin/nologin'],
  ['chrony', 997, 994, 'chrony system user', '/var/lib/chrony', '/sbin/nologin'],
  ['sshd', 74, 74, 'Privilege-separated SSH', '/usr/share/empty.sshd', '/sbin/nologin'],
  ['student', 1000, 1000, 'Student User', HOME, '/bin/bash'],
];

/** [name, gid, members] */
const DEFAULT_GROUPS = [
  ['root', 0, []],
  ['bin', 1, []],
  ['daemon', 2, []],
  ['sys', 3, []],
  ['adm', 4, []],
  ['tty', 5, []],
  ['disk', 6, []],
  ['lp', 7, []],
  ['mem', 8, []],
  ['kmem', 9, []],
  ['wheel', 10, ['student']],
  ['cdrom', 11, []],
  ['mail', 12, []],
  ['man', 15, []],
  ['dialout', 18, []],
  ['floppy', 19, []],
  ['games', 20, []],
  ['tape', 33, []],
  ['video', 39, []],
  ['ftp', 50, []],
  ['lock', 54, []],
  ['audio', 63, []],
  ['users', 100, []],
  ['nobody', 65534, []],
  ['utmp', 22, []],
  ['utempter', 35, []],
  ['input', 999, []],
  ['kvm', 36, []],
  ['render', 998, []],
  ['systemd-journal', 190, []],
  ['systemd-coredump', 997, []],
  ['dbus', 81, []],
  ['polkitd', 996, []],
  ['ssh_keys', 101, []],
  ['tss', 59, []],
  ['chrony', 994, []],
  ['sshd', 74, []],
  ['student', 1000, []],
];

const SHADOW_HASH = {
  root: '$6$rRVsDuo3nQb4JqZg$Fv1bVXl2lN4qXvVQ0wJ1mJk3pB2yH6xS0rN2bE3cE5n1cW9yQ8sP4bL7mD2xQ1rW6uE3oT5aK9zV0hG8jC4nF/',
  student:
    '$6$Q8xTq1wF0pYzR3sL$2mVbH7cN4kE9rT0yU6iO1pA3sD5fG7hJ8kL0zX2cV4bN6mQ8wE1rT3yU5iO7pA9sD1fG3hJ5kL7zX9cV1bN3m.',
};

// ─── SELinux file contexts (targeted policy, simplified file_contexts) ──────

const FCONTEXT_RULES = [
  [/^\/$/, 'root_t'],
  [/^\/home$/, 'home_root_t'],
  [/^\/home\/[^/]+$/, 'user_home_dir_t'],
  [/^\/home\/[^/]+\/\.ssh(\/.*)?$/, 'ssh_home_t'],
  [/^\/home\/[^/]+\/.+$/, 'user_home_t'],
  [/^\/root(\/.*)?$/, 'admin_home_t'],
  [/^\/tmp$/, 'tmp_t'],
  [/^\/tmp\/.+$/, 'user_tmp_t'],
  [/^\/var\/www\/cgi-bin(\/.*)?$/, 'httpd_sys_script_exec_t'],
  [/^\/var\/www(\/.*)?$/, 'httpd_sys_content_t'],
  [/^\/srv\/(www|web)(\/.*)?$/, 'httpd_sys_content_t'],
  [/^\/etc\/httpd(\/.*)?$/, 'httpd_config_t'],
  [/^\/etc\/nginx(\/.*)?$/, 'httpd_config_t'],
  [/^\/var\/log\/httpd(\/.*)?$/, 'httpd_log_t'],
  [/^\/var\/log\/nginx(\/.*)?$/, 'httpd_log_t'],
  [/^\/etc\/(g?shadow)(-)?$/, 'shadow_t'],
  [/^\/etc\/(passwd|group)(-)?$/, 'passwd_file_t'],
  [/^\/etc\/(hosts|resolv\.conf|hostname|nsswitch\.conf)$/, 'net_conf_t'],
  [/^\/etc\/selinux(\/.*)?$/, 'selinux_config_t'],
  [/^\/etc\/sudoers(\.d(\/.*)?)?$/, 'etc_t'],
  [/^\/etc\/firewalld(\/.*)?$/, 'firewalld_etc_rw_t'],
  [/^\/etc\/systemd\/system(\/.*)?$/, 'systemd_unit_file_t'],
  [/^\/usr\/lib\/systemd\/system(\/.*)?$/, 'systemd_unit_file_t'],
  [/^\/etc\/chrony\.conf$/, 'etc_t'],
  [/^\/etc(\/.*)?$/, 'etc_t'],
  [/^\/var\/lib\/mysql(\/.*)?$/, 'mysqld_db_t'],
  [/^\/var\/log(\/.*)?$/, 'var_log_t'],
  [/^\/var\/ftp(\/.*)?$/, 'public_content_t'],
  [/^\/var\/tmp(\/.*)?$/, 'tmp_t'],
  [/^\/var(\/.*)?$/, 'var_t'],
  [/^\/usr\/sbin\/httpd$/, 'httpd_exec_t'],
  [/^\/usr\/sbin\/sshd$/, 'sshd_exec_t'],
  [/^\/usr\/sbin\/chronyd$/, 'chronyd_exec_t'],
  [/^\/usr\/(s)?bin(\/.*)?$/, 'bin_t'],
  [/^\/usr\/lib(64)?(\/.*)?$/, 'lib_t'],
  [/^\/usr(\/.*)?$/, 'usr_t'],
  [/^\/opt(\/.*)?$/, 'usr_t'],
  [/^\/srv(\/.*)?$/, 'var_t'],
  [/^\/boot(\/.*)?$/, 'boot_t'],
  [/^\/dev\/null$/, 'null_device_t'],
  [/^\/dev\/(zero)$/, 'zero_device_t'],
  [/^\/dev\/u?random$/, 'random_device_t'],
  [/^\/dev\/vd[a-z][0-9]*$/, 'fixed_disk_device_t'],
  [/^\/dev(\/.*)?$/, 'device_t'],
  [/^\/proc(\/.*)?$/, 'proc_t'],
  [/^\/sys(\/.*)?$/, 'sysfs_t'],
  [/^\/run(\/.*)?$/, 'var_run_t'],
  [/^\/(media|mnt)(\/.*)?$/, 'mnt_t'],
  [/^\/afs$/, 'default_t'],
];

/** SELinux types the httpd_t domain may read (targeted policy). */
const HTTPD_READABLE_TYPES = new Set([
  'httpd_sys_content_t',
  'httpd_sys_rw_content_t',
  'httpd_sys_ra_content_t',
  'httpd_sys_script_exec_t',
  'httpd_user_content_t',
  'public_content_t',
  'public_content_rw_t',
]);

/** `semanage port -l` http_port_t defaults. */
const DEFAULT_PORT_TYPES = {
  http_port_t: {
    tcp: [80, 81, 443, 488, 8008, 8009, 8443, 9000],
  },
  ssh_port_t: { tcp: [22] },
  mysqld_port_t: {
    tcp: [
      1186, 3306, 63132, 63133, 63134, 63135, 63136, 63137, 63138, 63139, 63140, 63141, 63142,
      63143, 63144, 63145, 63146, 63147, 63148, 63149, 63150, 63151, 63152, 63153, 63154, 63155,
      63156, 63157, 63158, 63159, 63160, 63161, 63162, 63163, 63164,
    ],
  },
  ftp_port_t: { tcp: [21, 989, 990] },
  http_cache_port_t: {
    tcp: [8080, 8118, 8123, 10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008, 10009, 10010],
  },
};

// ─── dnf repositories + package catalog ─────────────────────────────────────

export const REPOS = {
  appstream: {
    id: 'rhel-9-for-x86_64-appstream-rpms',
    name: 'Red Hat Enterprise Linux 9 for x86_64 - AppStream (RPMs)',
    path: 'appstream',
  },
  baseos: {
    id: 'rhel-9-for-x86_64-baseos-rpms',
    name: 'Red Hat Enterprise Linux 9 for x86_64 - BaseOS (RPMs)',
    path: 'baseos',
  },
  rhocp: {
    id: 'rhocp-4.22-for-rhel-9-x86_64-rpms',
    name: 'Red Hat OpenShift Container Platform 4.22 for RHEL 9 x86_64 (RPMs)',
    path: 'rhocp/4.22',
  },
};

const HTTPD_CONF = `#
# This is the main Apache HTTP server configuration file.  It contains the
# configuration directives that give the server its instructions.
# See <URL:http://httpd.apache.org/docs/2.4/> for detailed information.
# In particular, see
# <URL:http://httpd.apache.org/docs/2.4/mod/directives.html>
# for a discussion of each configuration directive.
#
# Do NOT simply read the instructions in here without understanding
# what they do.  They're here only as hints or reminders.  If you are unsure
# consult the online docs. You have been warned.

ServerRoot "/etc/httpd"

#
# Listen: Allows you to bind Apache to specific IP addresses and/or
# ports, instead of the default. See also the <VirtualHost>
# directive.
#
#Listen 12.34.56.78:80
Listen 80

Include conf.modules.d/*.conf

User apache
Group apache

ServerAdmin root@localhost

#ServerName www.example.com:80

<Directory />
    AllowOverride none
    Require all denied
</Directory>

DocumentRoot "/var/www/html"

<Directory "/var/www">
    AllowOverride None
    # Allow open access:
    Require all granted
</Directory>

<Directory "/var/www/html">
    Options Indexes FollowSymLinks
    AllowOverride None
    Require all granted
</Directory>

<IfModule dir_module>
    DirectoryIndex index.html
</IfModule>

<Files ".ht*">
    Require all denied
</Files>

ErrorLog "logs/error_log"

LogLevel warn

<IfModule log_config_module>
    LogFormat "%h %l %u %t \\"%r\\" %>s %b \\"%{Referer}i\\" \\"%{User-Agent}i\\"" combined
    LogFormat "%h %l %u %t \\"%r\\" %>s %b" common
    CustomLog "logs/access_log" combined
</IfModule>

<IfModule alias_module>
    ScriptAlias /cgi-bin/ "/var/www/cgi-bin/"
</IfModule>

<Directory "/var/www/cgi-bin">
    AllowOverride None
    Options None
    Require all granted
</Directory>

<IfModule mime_module>
    TypesConfig /etc/mime.types
    AddType application/x-compress .Z
    AddType application/x-gzip .gz .tgz
    AddType text/html .shtml
    AddOutputFilter INCLUDES .shtml
</IfModule>

AddDefaultCharset UTF-8

<IfModule mime_magic_module>
    MIMEMagicFile conf/magic
</IfModule>

EnableSendfile on

# Supplemental configuration
#
# Load config files in the "/etc/httpd/conf.d" directory, if any.
IncludeOptional conf.d/*.conf
`;

const HTTPD_WELCOME_CONF = `#
# This configuration file enables the default "Welcome" page if there
# is no default index page present for the root URL.  To disable the
# Welcome page, comment out all the lines below.
#
# NOTE: if this file is removed, it will be restored on upgrades.
#
<LocationMatch "^/+$">
    Options -Indexes
    ErrorDocument 403 /.noindex.html
</LocationMatch>

<Directory /usr/share/httpd/noindex>
    AllowOverride None
    Require all granted
</Directory>

Alias /.noindex.html /usr/share/httpd/noindex/index.html
Alias /poweredby.png /usr/share/httpd/icons/apache_pb3.png
Alias /system_noindex_logo.png /usr/share/httpd/icons/system_noindex_logo.png
`;

/** The RHEL httpd test page (returned with 403 when DocumentRoot has no index.html). */
export const HTTPD_TEST_PAGE = `<!doctype html>
<html>
  <head>
    <meta charset='utf-8'>
    <meta name='viewport' content='width=device-width, initial-scale=1'>
    <title>HTTP Server Test Page powered by: Red Hat Enterprise Linux</title>
  </head>
  <body>
    <h1>Red Hat Enterprise Linux <strong>Test Page</strong></h1>
    <p class="lead">This page is used to test the proper operation of an HTTP server after it has been installed on a Red Hat Enterprise Linux system. If you can read this page, it means that the software is working correctly.</p>
    <h2>Just visiting?</h2>
    <p>This website you are visiting is either experiencing problems or could be going through maintenance.</p>
    <h2>Are you the Administrator?</h2>
    <p>You should add your website content to the directory <tt>/var/www/html/</tt>.</p>
    <p>To prevent this page from ever being used, follow the instructions in the file <tt>/etc/httpd/conf.d/welcome.conf</tt>.</p>
  </body>
</html>
`;

const NGINX_CONF = `# For more information on configuration, see:
#   * Official English Documentation: http://nginx.org/en/docs/
#   * Official Russian Documentation: http://nginx.org/ru/docs/

user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log;
pid /run/nginx.pid;

# Load dynamic modules. See /usr/share/doc/nginx/README.dynamic.
include /usr/share/nginx/modules/*.conf;

events {
    worker_connections 1024;
}

http {
    log_format  main  '$remote_addr - $remote_user [$time_local] "$request" '
                      '$status $body_bytes_sent "$http_referer" '
                      '"$http_user_agent" "$http_x_forwarded_for"';

    access_log  /var/log/nginx/access.log  main;

    sendfile            on;
    tcp_nopush          on;
    keepalive_timeout   65;
    types_hash_max_size 4096;

    include             /etc/nginx/mime.types;
    default_type        application/octet-stream;

    include /etc/nginx/conf.d/*.conf;

    server {
        listen       80;
        listen       [::]:80;
        server_name  _;
        root         /usr/share/nginx/html;

        include /etc/nginx/default.d/*.conf;

        error_page 404 /404.html;
        location = /404.html {
        }

        error_page 500 502 503 504 /50x.html;
        location = /50x.html {
        }
    }
}
`;

/**
 * Package catalog. Tuple: [name, evr (epoch:version-release), arch, repo key, download KiB,
 * installed KiB, summary, extra]. extra: installed (default workstation), requires, bins,
 * sbins, files (path → content|null for a directory|{…node}), units, users, url, license,
 * description.
 */
const PACKAGE_DEFS = [
  [
    'bash',
    '5.1.8-9.el9',
    'x86_64',
    'baseos',
    1777,
    7738,
    'The GNU Bourne Again shell',
    {
      installed: true,
      bins: ['bash', 'sh'],
      license: 'GPLv3+',
      url: 'https://www.gnu.org/software/bash',
    },
  ],
  [
    'coreutils',
    '8.32-39.el9',
    'x86_64',
    'baseos',
    1203,
    5745,
    'A set of basic GNU tools commonly used in shell scripts',
    {
      installed: true,
      license: 'GPLv3+',
      url: 'https://www.gnu.org/software/coreutils/',
      bins: [
        'cat',
        'cp',
        'mv',
        'rm',
        'ls',
        'mkdir',
        'rmdir',
        'touch',
        'ln',
        'chmod',
        'chown',
        'chgrp',
        'pwd',
        'echo',
        'printf',
        'cut',
        'sort',
        'uniq',
        'tr',
        'wc',
        'head',
        'tail',
        'tee',
        'stat',
        'du',
        'df',
        'id',
        'whoami',
        'groups',
        'env',
        'printenv',
        'date',
        'uname',
        'base64',
        'true',
        'false',
        'sleep',
        'basename',
        'dirname',
        'md5sum',
        'sha256sum',
        'diff',
      ],
    },
  ],
  [
    'kernel',
    '5.14.0-570.12.1.el9_6',
    'x86_64',
    'baseos',
    2390,
    0,
    'The Linux kernel, based on version 5.14.0, heavily modified with backports',
    {
      installed: true,
      license: 'GPLv2 and Redistributable, no modification permitted',
      url: 'https://www.kernel.org/',
    },
  ],
  [
    'systemd',
    '252-51.el9',
    'x86_64',
    'baseos',
    4325,
    13802,
    'System and Service Manager',
    {
      installed: true,
      bins: ['systemctl', 'journalctl', 'hostnamectl', 'timedatectl', 'loginctl'],
      license: 'LGPLv2+ and MIT and GPLv2+',
      url: 'https://systemd.io',
    },
  ],
  [
    'openssh-server',
    '8.7p1-45.el9',
    'x86_64',
    'baseos',
    459,
    1063,
    'An open source SSH server daemon',
    {
      installed: true,
      sbins: ['sshd'],
      units: ['sshd'],
      license: 'BSD',
      url: 'http://www.openssh.com/portable.html',
    },
  ],
  [
    'firewalld',
    '1.3.4-13.el9',
    'noarch',
    'baseos',
    466,
    2398,
    'A firewall daemon with D-Bus interface providing a dynamic firewall',
    {
      installed: true,
      bins: ['firewall-cmd'],
      units: ['firewalld'],
      license: 'GPLv2+',
      url: 'http://www.firewalld.org',
    },
  ],
  [
    'NetworkManager',
    '1:1.52.0-3.el9_6',
    'x86_64',
    'baseos',
    2349,
    6347,
    'Network connection manager and user applications',
    {
      installed: true,
      bins: ['nmcli'],
      units: ['NetworkManager'],
      license: 'GPLv2+ and LGPLv2+',
      url: 'https://networkmanager.dev/',
    },
  ],
  [
    'chrony',
    '4.6.1-1.el9',
    'x86_64',
    'baseos',
    343,
    666,
    'An NTP client/server',
    {
      installed: true,
      bins: ['chronyc'],
      units: ['chronyd'],
      license: 'GPLv2',
      url: 'https://chrony-project.org',
    },
  ],
  [
    'cronie',
    '1.5.7-14.el9',
    'x86_64',
    'baseos',
    125,
    288,
    'Cron daemon for executing programs at set times',
    {
      installed: true,
      bins: ['crontab'],
      units: ['crond'],
      license: 'MIT and BSD and ISC and GPLv2+',
      url: 'https://github.com/cronie-crond/cronie',
    },
  ],
  [
    'rsyslog',
    '8.2412.0-1.el9',
    'x86_64',
    'appstream',
    812,
    2554,
    'Enhanced system logging and kernel message trapping daemon',
    {
      installed: true,
      units: ['rsyslog'],
      license: '(GPLv3+ and ASL 2.0)',
      url: 'http://www.rsyslog.com/',
    },
  ],
  [
    'sudo',
    '1.9.5p2-10.el9_3',
    'x86_64',
    'baseos',
    1012,
    4682,
    'Allows restricted root access for specified users',
    { installed: true, bins: ['sudo'], license: 'ISC', url: 'https://www.sudo.ws' },
  ],
  [
    'curl',
    '7.76.1-31.el9',
    'x86_64',
    'baseos',
    302,
    676,
    'A utility for getting files from remote servers (FTP, HTTP, and others)',
    { installed: true, bins: ['curl'], license: 'MIT', url: 'https://curl.se/' },
  ],
  [
    'bind-utils',
    '32:9.16.23-29.el9_6',
    'x86_64',
    'appstream',
    203,
    541,
    'Utilities for querying DNS name servers',
    {
      installed: true,
      bins: ['dig', 'host', 'nslookup'],
      license: 'MPLv2.0',
      url: 'https://www.isc.org/downloads/bind/',
    },
  ],
  [
    'iproute',
    '6.11.0-1.el9',
    'x86_64',
    'baseos',
    822,
    2465,
    'Advanced IP routing and network device configuration tools',
    {
      installed: true,
      sbins: ['ip', 'ss'],
      license: 'GPLv2+ and Public Domain',
      url: 'https://kernel.org/pub/linux/utils/net/iproute2/',
    },
  ],
  [
    'iputils',
    '20210202-11.el9',
    'x86_64',
    'baseos',
    179,
    538,
    'Network monitoring tools including ping',
    {
      installed: true,
      bins: ['ping', 'tracepath'],
      license: 'BSD and GPLv2+',
      url: 'https://github.com/iputils/iputils',
    },
  ],
  [
    'procps-ng',
    '3.3.17-14.el9',
    'x86_64',
    'baseos',
    349,
    1012,
    'System and process monitoring utilities',
    {
      installed: true,
      bins: ['ps', 'pgrep', 'pkill', 'kill', 'top', 'free', 'uptime', 'w', 'watch'],
      license: 'GPL+ and GPLv2 and GPLv2+ and GPLv3+ and LGPLv2+',
      url: 'https://sourceforge.net/projects/procps-ng/',
    },
  ],
  [
    'tar',
    '2:1.34-7.el9',
    'x86_64',
    'baseos',
    889,
    2992,
    'GNU file archiving program',
    { installed: true, bins: ['tar'], license: 'GPLv3+', url: 'https://www.gnu.org/software/tar/' },
  ],
  [
    'gzip',
    '1.12-1.el9',
    'x86_64',
    'baseos',
    169,
    386,
    'The GNU data compression program',
    {
      installed: true,
      bins: ['gzip', 'gunzip', 'zcat'],
      license: 'GPLv3+ and GFDL',
      url: 'https://www.gzip.org/',
    },
  ],
  [
    'file',
    '5.39-16.el9',
    'x86_64',
    'baseos',
    52,
    101,
    'Utility for determining file types',
    { installed: true, bins: ['file'], license: 'BSD', url: 'https://www.darwinsys.com/file/' },
  ],
  [
    'findutils',
    '1:4.8.0-7.el9',
    'x86_64',
    'baseos',
    552,
    1767,
    'The GNU versions of find utilities (find and xargs)',
    {
      installed: true,
      bins: ['find', 'xargs'],
      license: 'GPLv3+',
      url: 'https://www.gnu.org/software/findutils/',
    },
  ],
  [
    'grep',
    '3.6-5.el9',
    'x86_64',
    'baseos',
    280,
    864,
    'Pattern matching utilities',
    {
      installed: true,
      bins: ['grep', 'egrep', 'fgrep'],
      license: 'GPLv3+',
      url: 'https://www.gnu.org/software/grep/',
    },
  ],
  [
    'sed',
    '4.8-9.el9',
    'x86_64',
    'baseos',
    312,
    806,
    'A GNU stream text editor',
    { installed: true, bins: ['sed'], license: 'GPLv3+', url: 'https://www.gnu.org/software/sed/' },
  ],
  [
    'less',
    '590-5.el9',
    'x86_64',
    'baseos',
    164,
    368,
    'A text file browser similar to more, but better',
    {
      installed: true,
      bins: ['less'],
      license: 'GPLv3+ or BSD',
      url: 'http://www.greenwoodsoftware.com/less/',
    },
  ],
  [
    'util-linux',
    '2.37.4-21.el9',
    'x86_64',
    'baseos',
    2349,
    10898,
    'A collection of basic system utilities',
    {
      installed: true,
      bins: ['more', 'su', 'kill', 'mount'],
      license: 'GPLv2 and GPLv2+ and LGPLv2+ and BSD with advertising and Public Domain',
      url: 'http://en.wikipedia.org/wiki/Util-linux',
    },
  ],
  [
    'shadow-utils',
    '2:4.9-12.el9',
    'x86_64',
    'baseos',
    1251,
    3896,
    'Utilities for managing accounts and shadow password files',
    {
      installed: true,
      sbins: ['useradd', 'usermod', 'userdel', 'groupadd', 'groupmod', 'groupdel'],
      license: 'BSD and GPLv2+',
      url: 'https://github.com/shadow-maint/shadow',
    },
  ],
  [
    'passwd',
    '0.80-12.el9',
    'x86_64',
    'baseos',
    115,
    220,
    'An utility for setting or changing passwords using PAM',
    { installed: true, bins: ['passwd'], license: 'BSD or GPL+', url: 'https://pagure.io/passwd' },
  ],
  [
    'hostname',
    '3.23-6.el9',
    'x86_64',
    'baseos',
    30,
    73,
    'Utility to set/show the host name or domain name',
    {
      installed: true,
      bins: ['hostname'],
      license: 'GPLv2+',
      url: 'http://packages.qa.debian.org/h/hostname.html',
    },
  ],
  [
    'which',
    '2.21-29.el9',
    'x86_64',
    'baseos',
    45,
    81,
    'Displays where a particular program in your path is located',
    {
      installed: true,
      bins: ['which'],
      license: 'GPLv3',
      url: 'https://savannah.gnu.org/projects/which/',
    },
  ],
  [
    'vim-enhanced',
    '2:8.2.2637-21.el9',
    'x86_64',
    'appstream',
    1838,
    4093,
    'A version of the VIM editor which includes recent enhancements',
    { installed: true, bins: ['vim', 'vi'], license: 'Vim and MIT', url: 'http://www.vim.org/' },
  ],
  [
    'nano',
    '5.6.1-6.el9',
    'x86_64',
    'baseos',
    712,
    2683,
    'A small text editor',
    { installed: true, bins: ['nano'], license: 'GPLv3+', url: 'https://www.nano-editor.org' },
  ],
  [
    'policycoreutils',
    '3.6-2.1.el9',
    'x86_64',
    'baseos',
    242,
    711,
    'SELinux policy core utilities',
    {
      installed: true,
      sbins: ['getenforce', 'setenforce', 'sestatus', 'restorecon', 'fixfiles'],
      license: 'GPLv2',
      url: 'https://github.com/SELinuxProject/selinux',
    },
  ],
  [
    'policycoreutils-python-utils',
    '3.6-2.1.el9',
    'noarch',
    'appstream',
    72,
    141,
    'SELinux policy core python utilities',
    {
      installed: true,
      sbins: ['semanage'],
      license: 'GPLv2',
      url: 'https://github.com/SELinuxProject/selinux',
    },
  ],
  [
    'coreutils-selinux',
    '8.32-39.el9',
    'x86_64',
    'baseos',
    0,
    0,
    'chcon from coreutils',
    { installed: false, hidden: true },
  ],
  [
    'openssl',
    '1:3.2.2-6.el9_5.1',
    'x86_64',
    'baseos',
    1415,
    1912,
    'Utilities from the general purpose cryptography library with TLS implementation',
    { installed: true, bins: ['openssl'], license: 'ASL 2.0', url: 'http://www.openssl.org/' },
  ],
  [
    'podman',
    '5:5.4.0-9.el9_6',
    'x86_64',
    'appstream',
    17154,
    54102,
    'Manage Pods, Containers and Container Images',
    {
      installed: true,
      bins: ['podman'],
      requires: ['passt'],
      license: 'Apache-2.0 AND BSD-2-Clause AND BSD-3-Clause AND ISC AND MIT AND MPL-2.0',
      url: 'https://podman.io/',
    },
  ],
  [
    'passt',
    '0^20250217.ga1e48a0-1.el9',
    'x86_64',
    'appstream',
    236,
    641,
    'User-mode networking daemons for virtual machines and namespaces',
    {
      installed: true,
      bins: ['pasta', 'passt'],
      license: 'GPL-2.0-or-later AND BSD-3-Clause',
      url: 'https://passt.top/',
    },
  ],
  [
    'buildah',
    '2:1.39.4-1.el9_6',
    'x86_64',
    'appstream',
    11026,
    37144,
    'A command line tool used for creating OCI Images',
    {
      installed: true,
      bins: ['buildah'],
      license: 'Apache-2.0 AND BSD-2-Clause AND BSD-3-Clause AND ISC AND MIT AND MPL-2.0',
      url: 'https://buildah.io',
    },
  ],
  [
    'skopeo',
    '2:1.18.1-1.el9',
    'x86_64',
    'appstream',
    9310,
    31602,
    'Inspect container images and repositories on registries',
    {
      installed: true,
      bins: ['skopeo'],
      license: 'Apache-2.0 AND BSD-2-Clause AND BSD-3-Clause AND ISC AND MIT AND MPL-2.0',
      url: 'https://github.com/containers/skopeo',
      description:
        'Command line utility to inspect images and repositories directly on Docker\nregistries without the need to pull them.',
    },
  ],
  [
    'httpd-tools',
    '2.4.62-4.el9',
    'x86_64',
    'appstream',
    82,
    205,
    'Tools for use with the Apache HTTP Server',
    {
      installed: true,
      bins: ['htpasswd', 'ab'],
      license: 'ASL 2.0',
      url: 'https://httpd.apache.org/',
    },
  ],
  [
    'bash-completion',
    '1:2.11-5.el9',
    'noarch',
    'baseos',
    456,
    1312,
    'Programmable completion for Bash',
    { installed: true, license: 'GPLv2+', url: 'https://github.com/scop/bash-completion' },
  ],
  [
    'man-db',
    '2.9.3-7.el9',
    'x86_64',
    'baseos',
    1220,
    2805,
    'Tools for searching and reading man pages',
    {
      installed: true,
      bins: ['man'],
      license: 'GPLv2+ and GPLv3+',
      url: 'http://www.nongnu.org/man-db/',
    },
  ],
  [
    'openshift-clients',
    `${OCP_VERSION}-202610281432.p0.g4e7b8a2.assembly.stream.el9`,
    'x86_64',
    'rhocp',
    52316,
    225480,
    'OpenShift client binaries',
    {
      installed: true,
      bins: ['oc', 'kubectl'],
      license: 'ASL 2.0',
      url: 'https://github.com/openshift/oc',
      description: 'OpenShift client binaries',
    },
  ],
  // ── available (not installed by default) ──
  [
    'apr',
    '1.7.0-12.el9_3',
    'x86_64',
    'appstream',
    126,
    289,
    'Apache Portable Runtime library',
    { license: 'ASL 2.0 and BSD with advertising and ISC and BSD', url: 'https://apr.apache.org/' },
  ],
  [
    'apr-util',
    '1.6.1-23.el9',
    'x86_64',
    'appstream',
    98,
    216,
    'Apache Portable Runtime Utility library',
    { requires: ['apr'], license: 'ASL 2.0', url: 'https://apr.apache.org/' },
  ],
  [
    'apr-util-bdb',
    '1.6.1-23.el9',
    'x86_64',
    'appstream',
    13,
    23,
    'APR utility library Berkeley DB driver',
    { requires: ['apr-util'], license: 'ASL 2.0', url: 'https://apr.apache.org/' },
  ],
  [
    'apr-util-openssl',
    '1.6.1-23.el9',
    'x86_64',
    'appstream',
    15,
    27,
    'APR utility library OpenSSL crypto support',
    { requires: ['apr-util'], license: 'ASL 2.0', url: 'https://apr.apache.org/' },
  ],
  [
    'httpd-filesystem',
    '2.4.62-4.el9',
    'noarch',
    'appstream',
    12,
    0,
    'The basic directory layout for the Apache HTTP Server',
    {
      license: 'ASL 2.0',
      url: 'https://httpd.apache.org/',
      users: [['apache', 48, 48, 'Apache', '/usr/share/httpd', '/sbin/nologin']],
    },
  ],
  [
    'httpd-core',
    '2.4.62-4.el9',
    'x86_64',
    'appstream',
    1430,
    4637,
    'httpd minimal core',
    {
      requires: ['apr', 'apr-util', 'httpd-filesystem', 'httpd-tools'],
      sbins: ['httpd', 'apachectl'],
      license: 'ASL 2.0',
      url: 'https://httpd.apache.org/',
    },
  ],
  [
    'mod_http2',
    '2.0.26-4.el9',
    'x86_64',
    'appstream',
    163,
    405,
    'module implementing HTTP/2 for Apache 2',
    { license: 'ASL 2.0', url: 'https://icing.github.io/mod_h2/' },
  ],
  [
    'mod_lua',
    '2.4.62-4.el9',
    'x86_64',
    'appstream',
    59,
    141,
    'Lua language module for the Apache HTTP Server',
    { license: 'ASL 2.0', url: 'https://httpd.apache.org/' },
  ],
  [
    'redhat-logos-httpd',
    '90.4-2.el9',
    'noarch',
    'appstream',
    18,
    21,
    'Red Hat Enterprise Linux-related icons and pictures used by httpd',
    {
      license: 'Licensed only for approved usage, see COPYING for details.',
      url: 'https://www.redhat.com/',
    },
  ],
  [
    'httpd',
    '2.4.62-4.el9',
    'x86_64',
    'appstream',
    51,
    61,
    'Apache HTTP Server',
    {
      requires: [
        'apr',
        'apr-util',
        'apr-util-bdb',
        'apr-util-openssl',
        'httpd-core',
        'httpd-filesystem',
        'httpd-tools',
        'mod_http2',
        'mod_lua',
        'redhat-logos-httpd',
      ],
      units: ['httpd'],
      license: 'ASL 2.0',
      url: 'https://httpd.apache.org/',
      description: 'The Apache HTTP Server is a powerful, efficient, and extensible\nweb server.',
      files: {
        '/etc/httpd': null,
        '/etc/httpd/conf': null,
        '/etc/httpd/conf/httpd.conf': HTTPD_CONF,
        '/etc/httpd/conf.d': null,
        '/etc/httpd/conf.d/welcome.conf': HTTPD_WELCOME_CONF,
        '/etc/httpd/conf.d/README':
          '\nThis directory holds configuration files for the Apache HTTP Server;\nany files in this directory which have the ".conf" extension will be\nprocessed as httpd configuration files.  The directory is used in\naddition to the directory /etc/httpd/conf.modules.d/, which contains\nconfiguration files necessary to load modules.\n',
        '/etc/httpd/conf.modules.d': null,
        '/etc/httpd/conf.modules.d/00-base.conf':
          '#\n# This file loads most of the modules included with the Apache HTTP\n# Server itself.\n#\n\nLoadModule access_compat_module modules/mod_access_compat.so\nLoadModule alias_module modules/mod_alias.so\nLoadModule authz_core_module modules/mod_authz_core.so\nLoadModule dir_module modules/mod_dir.so\nLoadModule log_config_module modules/mod_log_config.so\nLoadModule mime_module modules/mod_mime.so\n',
        '/etc/httpd/logs': { type: 'link', target: '../../var/log/httpd' },
        '/etc/httpd/modules': { type: 'link', target: '../../usr/lib64/httpd/modules' },
        '/etc/httpd/run': { type: 'link', target: '/run/httpd' },
        '/var/www': null,
        '/var/www/html': null,
        '/var/www/cgi-bin': null,
        '/var/log/httpd': { type: 'dir', mode: 0o700 },
        '/var/log/httpd/error_log': { generator: 'httpd-error-log', mode: 0o644 },
        '/var/log/httpd/access_log': { generator: 'httpd-access-log', mode: 0o644 },
        '/usr/share/httpd/noindex/index.html': HTTPD_TEST_PAGE,
      },
    },
  ],
  [
    'nginx-filesystem',
    '2:1.20.1-22.el9_6.2',
    'noarch',
    'appstream',
    11,
    0,
    'The basic directory layout for the Nginx server',
    {
      license: 'BSD',
      url: 'https://nginx.org',
      users: [['nginx', 992, 992, 'Nginx web server', '/var/lib/nginx', '/sbin/nologin']],
    },
  ],
  [
    'nginx-core',
    '2:1.20.1-22.el9_6.2',
    'x86_64',
    'appstream',
    589,
    1752,
    'nginx minimal core',
    { requires: ['nginx-filesystem'], sbins: ['nginx'], license: 'BSD', url: 'https://nginx.org' },
  ],
  [
    'nginx',
    '2:1.20.1-22.el9_6.2',
    'x86_64',
    'appstream',
    37,
    49,
    'A high performance web server and reverse proxy server',
    {
      requires: ['nginx-core', 'nginx-filesystem', 'redhat-logos-httpd'],
      units: ['nginx'],
      license: 'BSD',
      url: 'https://nginx.org',
      files: {
        '/etc/nginx': null,
        '/etc/nginx/nginx.conf': NGINX_CONF,
        '/etc/nginx/conf.d': null,
        '/etc/nginx/default.d': null,
        '/usr/share/nginx/html': null,
        '/usr/share/nginx/html/index.html': HTTPD_TEST_PAGE,
        '/var/log/nginx': { type: 'dir', mode: 0o711 },
      },
    },
  ],
  [
    'mariadb-server',
    '3:10.5.27-1.el9_5',
    'x86_64',
    'appstream',
    9839,
    50223,
    'The MariaDB server and related files',
    {
      units: ['mariadb'],
      sbins: ['mariadbd'],
      bins: ['mysql', 'mariadb'],
      users: [['mysql', 27, 27, 'MySQL Server', '/var/lib/mysql', '/sbin/nologin']],
      license: 'GPLv2 and LGPLv2',
      url: 'http://mariadb.org',
      files: {
        '/var/lib/mysql': { type: 'dir', mode: 0o755, owner: 'mysql', group: 'mysql' },
        '/etc/my.cnf.d': null,
        '/etc/my.cnf.d/mariadb-server.cnf':
          '#\n# These groups are read by MariaDB server.\n# Use it for options that only the server (but not clients) should see\n\n[mysqld]\ndatadir=/var/lib/mysql\nsocket=/var/lib/mysql/mysql.sock\nlog-error=/var/log/mariadb/mariadb.log\npid-file=/run/mariadb/mariadb.pid\n',
      },
    },
  ],
  [
    'vsftpd',
    '3.0.5-6.el9',
    'x86_64',
    'appstream',
    171,
    349,
    'Very Secure Ftp Daemon',
    {
      units: ['vsftpd'],
      sbins: ['vsftpd'],
      license: 'GPLv2 with exceptions',
      url: 'https://security.appspot.com/vsftpd.html',
      files: {
        '/etc/vsftpd': null,
        '/etc/vsftpd/vsftpd.conf':
          'anonymous_enable=NO\nlocal_enable=YES\nwrite_enable=YES\nlocal_umask=022\ndirmessage_enable=YES\nxferlog_enable=YES\nconnect_from_port_20=YES\nxferlog_std_format=YES\nlisten=NO\nlisten_ipv6=YES\n\npam_service_name=vsftpd\nuserlist_enable=YES\n',
        '/var/ftp': null,
        '/var/ftp/pub': null,
      },
    },
  ],
  [
    'tree',
    '1.8.0-10.el9',
    'x86_64',
    'baseos',
    59,
    114,
    'File system tree viewer',
    { bins: ['tree'], license: 'GPLv2+', url: 'http://mama.indstate.edu/users/ice/tree/' },
  ],
  [
    'git',
    '2.47.1-1.el9',
    'x86_64',
    'appstream',
    51,
    87,
    'Fast Version Control System',
    { bins: ['git'], license: 'GPLv2', url: 'https://git-scm.com/' },
  ],
  [
    'tmux',
    '3.2a-5.el9',
    'x86_64',
    'baseos',
    476,
    1091,
    'A terminal multiplexer',
    { bins: ['tmux'], license: 'ISC and BSD', url: 'https://tmux.github.io/' },
  ],
  [
    'lsof',
    '4.94.0-3.el9',
    'x86_64',
    'baseos',
    242,
    1069,
    'A utility which lists open files on a Linux/UNIX system',
    {
      bins: ['lsof'],
      license: 'zlib and Sendmail and LGPLv2+',
      url: 'https://github.com/lsof-org/lsof',
    },
  ],
  [
    'wget',
    '1.21.1-8.el9_4',
    'x86_64',
    'appstream',
    788,
    3164,
    'A utility for retrieving files using the HTTP or FTP protocols',
    { bins: ['wget'], license: 'GPLv3+', url: 'http://www.gnu.org/software/wget/' },
  ],
  [
    'zip',
    '3.0-35.el9',
    'x86_64',
    'baseos',
    270,
    723,
    'A file compression and packaging utility compatible with PKZIP',
    { bins: ['zip'], license: 'BSD', url: 'http://www.info-zip.org/Zip.html' },
  ],
  [
    'unzip',
    '6.0-58.el9_5',
    'x86_64',
    'baseos',
    186,
    410,
    'A utility for unpacking zip files',
    { bins: ['unzip'], license: 'BSD', url: 'http://infozip.sourceforge.net/UnZip.html' },
  ],
  [
    'nmap-ncat',
    '3:7.92-3.el9',
    'x86_64',
    'appstream',
    225,
    461,
    "Nmap's Netcat replacement",
    { bins: ['nc', 'ncat'], license: 'Nmap', url: 'https://nmap.org/ncat/' },
  ],
  [
    'stress-ng',
    '0.17.08-1.el9',
    'x86_64',
    'appstream',
    2420,
    7841,
    'Stress test a computer system in various ways',
    { bins: ['stress-ng'], license: 'GPLv2+', url: 'https://github.com/ColinIanKing/stress-ng' },
  ],
];

/** Commands provided by packages (missing package → `bash: <cmd>: command not found`). */
export const COMMAND_PACKAGE = (() => {
  const map = new Map();
  for (const def of PACKAGE_DEFS) {
    const extra = def[7] || {};
    for (const bin of extra.bins || []) if (!map.has(bin)) map.set(bin, def[0]);
    for (const bin of extra.sbins || []) if (!map.has(bin)) map.set(bin, def[0]);
  }
  // procps-ng owns kill/top/free (util-linux also ships a kill; procps is what bash finds).
  for (const name of ['ps', 'pgrep', 'pkill', 'top', 'free', 'uptime', 'kill'])
    map.set(name, 'procps-ng');
  return map;
})();

// ─── systemd units ──────────────────────────────────────────────────────────

/**
 * Built-in service definitions. `cmd` is the main process cmdline, `comm` its name,
 * `workers` extra child processes, `ports` listening sockets ([proto, port, addr]),
 * `user` the process user, `label` the SELinux domain.
 */
const UNIT_DEFS = {
  sshd: {
    description: 'OpenSSH server daemon',
    docs: ['man:sshd(8)', 'man:sshd_config(5)'],
    type: 'notify',
    exec: '/usr/sbin/sshd -D $OPTIONS',
    reload: '/bin/kill -HUP $MAINPID',
    cmd: 'sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups',
    comm: 'sshd',
    ports: [
      ['tcp', 22, '0.0.0.0'],
      ['tcp', 22, '[::]'],
    ],
    preset: 'enabled',
    pkg: 'openssh-server',
    label: 'sshd_t',
    memory: '6.1M',
    restart: 'on-failure',
    validator: 'sshd',
  },
  firewalld: {
    description: 'firewalld - dynamic firewall daemon',
    docs: ['man:firewalld(1)'],
    type: 'dbus',
    exec: '/usr/sbin/firewalld --nofork --nopid $FIREWALLD_ARGS',
    cmd: '/usr/bin/python3 -s /usr/sbin/firewalld --nofork --nopid',
    comm: 'firewalld',
    preset: 'enabled',
    pkg: 'firewalld',
    label: 'firewalld_t',
    memory: '42.6M',
    cpu: 0.0,
    mem: 1.2,
  },
  chronyd: {
    description: 'NTP client/server',
    docs: ['man:chronyd(8)', 'man:chrony.conf(5)'],
    type: 'forking',
    exec: '/usr/sbin/chronyd $OPTIONS',
    cmd: '/usr/sbin/chronyd -F 2',
    comm: 'chronyd',
    user: 'chrony',
    ports: [
      ['udp', 323, '127.0.0.1'],
      ['udp', 323, '[::1]'],
    ],
    preset: 'enabled',
    pkg: 'chrony',
    label: 'chronyd_t',
    memory: '1.1M',
  },
  crond: {
    description: 'Command Scheduler',
    type: 'simple',
    exec: '/usr/sbin/crond -n $CRONDARGS',
    cmd: '/usr/sbin/crond -n',
    comm: 'crond',
    preset: 'enabled',
    pkg: 'cronie',
    label: 'crond_t',
    memory: '1.0M',
  },
  atd: {
    description: 'Deferred execution scheduler',
    docs: ['man:atd(8)'],
    type: 'simple',
    exec: '/usr/sbin/atd -f $OPTS',
    cmd: '/usr/sbin/atd -f',
    comm: 'atd',
    preset: 'enabled',
    label: 'crond_t',
    memory: '284.0K',
  },
  NetworkManager: {
    description: 'Network Manager',
    docs: ['man:NetworkManager(8)'],
    type: 'dbus',
    exec: '/usr/sbin/NetworkManager --no-daemon',
    cmd: '/usr/sbin/NetworkManager --no-daemon',
    comm: 'NetworkManager',
    preset: 'enabled',
    pkg: 'NetworkManager',
    label: 'NetworkManager_t',
    memory: '10.4M',
  },
  rsyslog: {
    description: 'System Logging Service',
    docs: ['man:rsyslogd(8)', 'https://www.rsyslog.com/doc/'],
    type: 'notify',
    exec: '/usr/sbin/rsyslogd -n $SYSLOGD_OPTIONS',
    cmd: '/usr/sbin/rsyslogd -n',
    comm: 'rsyslogd',
    preset: 'enabled',
    pkg: 'rsyslog',
    label: 'syslogd_t',
    memory: '3.9M',
  },
  auditd: {
    description: 'Security Auditing Service',
    docs: ['man:auditd(8)', 'https://github.com/linux-audit/audit-documentation'],
    type: 'forking',
    exec: '/sbin/auditd',
    cmd: '/sbin/auditd',
    comm: 'auditd',
    preset: 'enabled',
    label: 'auditd_t',
    memory: '1.5M',
  },
  tuned: {
    description: 'Dynamic System Tuning Daemon',
    docs: ['man:tuned(8)', 'man:tuned.conf(5)', 'man:tuned-adm(8)'],
    type: 'dbus',
    exec: '/usr/sbin/tuned -l -P',
    cmd: '/usr/bin/python3 -Es /usr/sbin/tuned -l -P',
    comm: 'tuned',
    preset: 'enabled',
    label: 'tuned_t',
    memory: '17.3M',
    mem: 0.6,
  },
  irqbalance: {
    description: 'irqbalance daemon',
    docs: ['man:irqbalance(1)', 'https://github.com/Irqbalance/irqbalance'],
    type: 'simple',
    exec: '/usr/sbin/irqbalance --foreground $IRQBALANCE_ARGS',
    cmd: '/usr/sbin/irqbalance --foreground',
    comm: 'irqbalance',
    preset: 'enabled',
    label: 'irqbalance_t',
    memory: '1.1M',
  },
  'dbus-broker': {
    description: 'D-Bus System Message Bus',
    docs: ['man:dbus-broker-launch(1)'],
    type: 'notify',
    exec: '/usr/bin/dbus-broker-launch --scope system --audit',
    cmd: '/usr/bin/dbus-broker-launch --scope system --audit',
    comm: 'dbus-broker-lau',
    user: 'dbus',
    preset: 'enabled',
    label: 'system_dbusd_t',
    memory: '2.6M',
    workers: [
      [
        'dbus-broker',
        'dbus-broker --log 4 --controller 9 --machine-id 2d0a8c1f7e9b4b5c9a3f6e1d2c4b8a07 --max-bytes 536870912 --max-fds 4096 --max-matches 16384 --audit',
      ],
    ],
  },
  polkit: {
    description: 'Authorization Manager',
    docs: ['man:polkit(8)'],
    type: 'dbus',
    exec: '/usr/lib/polkit-1/polkitd --no-debug',
    cmd: '/usr/lib/polkit-1/polkitd --no-debug',
    comm: 'polkitd',
    user: 'polkitd',
    preset: 'static',
    label: 'policykit_t',
    memory: '5.4M',
  },
  'systemd-journald': {
    description: 'Journal Service',
    docs: ['man:systemd-journald.service(8)', 'man:journald.conf(5)'],
    type: 'notify',
    exec: '/usr/lib/systemd/systemd-journald',
    cmd: '/usr/lib/systemd/systemd-journald',
    comm: 'systemd-journal',
    preset: 'static',
    label: 'syslogd_t',
    memory: '9.4M',
  },
  'systemd-logind': {
    description: 'User Login Management',
    docs: [
      'man:sd-login(3)',
      'man:systemd-logind.service(8)',
      'man:logind.conf(5)',
      'man:org.freedesktop.login1(5)',
    ],
    type: 'notify',
    exec: '/usr/lib/systemd/systemd-logind',
    cmd: '/usr/lib/systemd/systemd-logind',
    comm: 'systemd-logind',
    preset: 'static',
    label: 'systemd_logind_t',
    memory: '1.9M',
  },
  'systemd-udevd': {
    description: 'Rule-based Manager for Device Events and Files',
    docs: ['man:systemd-udevd.service(8)', 'man:udev(7)'],
    type: 'notify',
    exec: '/usr/lib/systemd/systemd-udevd',
    cmd: '/usr/lib/systemd/systemd-udevd',
    comm: 'systemd-udevd',
    preset: 'static',
    label: 'udev_t',
    memory: '3.7M',
  },
  'getty@tty1': {
    description: 'Getty on tty1',
    docs: ['man:agetty(8)', 'man:systemd-getty-generator(8)'],
    type: 'idle',
    exec: "-/sbin/agetty -o '-p -- \\\\u' --noclear - $TERM",
    cmd: '/sbin/agetty -o -p -- \\u --noclear - linux',
    comm: 'agetty',
    preset: 'enabled',
    label: 'getty_t',
    memory: '216.0K',
    tty: 'tty1',
  },
  httpd: {
    description: 'The Apache HTTP Server',
    docs: ['man:httpd.service(8)'],
    type: 'notify',
    exec: '/usr/sbin/httpd $OPTIONS -DFOREGROUND',
    reload: '/usr/sbin/httpd $OPTIONS -k graceful',
    cmd: '/usr/sbin/httpd -DFOREGROUND',
    comm: 'httpd',
    workers: [
      ['httpd', '/usr/sbin/httpd -DFOREGROUND', 'apache'],
      ['httpd', '/usr/sbin/httpd -DFOREGROUND', 'apache'],
      ['httpd', '/usr/sbin/httpd -DFOREGROUND', 'apache'],
      ['httpd', '/usr/sbin/httpd -DFOREGROUND', 'apache'],
    ],
    preset: 'disabled',
    pkg: 'httpd',
    label: 'httpd_t',
    memory: '33.1M',
    tasks: 177,
    statusText:
      'Total requests: 0; Idle/Busy workers 100/0;Requests/sec: 0; Bytes served/sec:   0 B/sec',
    validator: 'httpd',
    unitFile: `# See httpd.service(8) for more information on using the httpd service.

# Modifying this file in-place is not recommended, because changes
# will be overwritten during package upgrades.  To customize the
# behaviour, run "systemctl edit httpd" to create an override unit.

# For example, to pass additional options (such as -D definitions) to
# the httpd binary at startup, create an override unit (as is done by
# systemctl edit) and enter the following:

#	[Service]
#	Environment=OPTIONS=-DMY_DEFINE

[Unit]
Description=The Apache HTTP Server
Wants=httpd-init.service
After=network.target remote-fs.target nss-lookup.target httpd-init.service
Documentation=man:httpd.service(8)

[Service]
Type=notify
Environment=LANG=C

ExecStart=/usr/sbin/httpd $OPTIONS -DFOREGROUND
ExecReload=/usr/sbin/httpd $OPTIONS -k graceful
# Send SIGWINCH for graceful stop
KillSignal=SIGWINCH
KillMode=mixed
PrivateTmp=true
OOMPolicy=continue

[Install]
WantedBy=multi-user.target
`,
  },
  nginx: {
    description: 'The nginx HTTP and reverse proxy server',
    type: 'forking',
    exec: '/usr/sbin/nginx',
    cmd: 'nginx: master process /usr/sbin/nginx',
    comm: 'nginx',
    workers: [
      ['nginx', 'nginx: worker process', 'nginx'],
      ['nginx', 'nginx: worker process', 'nginx'],
    ],
    ports: [
      ['tcp', 80, '0.0.0.0'],
      ['tcp', 80, '[::]'],
    ],
    preset: 'disabled',
    pkg: 'nginx',
    label: 'httpd_t',
    memory: '4.9M',
  },
  mariadb: {
    description: 'MariaDB 10.5 database server',
    docs: ['man:mariadbd(8)', 'https://mariadb.com/kb/en/library/systemd/'],
    type: 'notify',
    exec: '/usr/libexec/mariadbd --basedir=/usr $MYSQLD_OPTS $_WSREP_NEW_CLUSTER',
    cmd: '/usr/libexec/mariadbd --basedir=/usr',
    comm: 'mariadbd',
    user: 'mysql',
    ports: [['tcp', 3306, '*']],
    preset: 'disabled',
    pkg: 'mariadb-server',
    label: 'mysqld_t',
    memory: '80.2M',
    mem: 2.4,
    statusText: 'Taking your SQL requests now...',
  },
  vsftpd: {
    description: 'Vsftpd ftp daemon',
    type: 'forking',
    exec: '/usr/sbin/vsftpd /etc/vsftpd/vsftpd.conf',
    cmd: '/usr/sbin/vsftpd /etc/vsftpd/vsftpd.conf',
    comm: 'vsftpd',
    ports: [['tcp', 21, '*']],
    preset: 'disabled',
    pkg: 'vsftpd',
    label: 'ftpd_t',
    memory: '724.0K',
  },
};

/** Units enabled + running on the default workstation (boot order). */
const DEFAULT_RUNNING_UNITS = [
  'systemd-journald',
  'systemd-udevd',
  'auditd',
  'dbus-broker',
  'irqbalance',
  'systemd-logind',
  'polkit',
  'chronyd',
  'NetworkManager',
  'firewalld',
  'tuned',
  'rsyslog',
  'sshd',
  'crond',
  'atd',
  'getty@tty1',
];

/** Non-service units shown by a bare `systemctl list-units`. */
const OTHER_UNITS = [
  ['-.mount', 'Root Mount', 'mounted'],
  ['boot.mount', '/boot', 'mounted'],
  ['boot-efi.mount', '/boot/efi', 'mounted'],
  ['tmp.mount', 'Temporary Directory /tmp', 'mounted'],
  ['dbus.socket', 'D-Bus System Message Bus Socket', 'running'],
  ['sshd-keygen.target', 'sshd-keygen.target', 'active'],
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

// ─── firewalld ──────────────────────────────────────────────────────────────

/** `firewall-cmd --get-services` (subset of firewalld 1.3, with their ports). */
export const FIREWALL_SERVICES = {
  cockpit: ['9090/tcp'],
  'dhcpv6-client': ['546/udp'],
  dns: ['53/tcp', '53/udp'],
  ftp: ['21/tcp'],
  http: ['80/tcp'],
  http3: ['443/udp'],
  https: ['443/tcp'],
  imap: ['143/tcp'],
  imaps: ['993/tcp'],
  kerberos: ['88/tcp', '88/udp'],
  ldap: ['389/tcp'],
  ldaps: ['636/tcp'],
  mdns: ['5353/udp'],
  mysql: ['3306/tcp'],
  nfs: ['2049/tcp'],
  ntp: ['123/udp'],
  'openshift-api': [],
  pop3: ['110/tcp'],
  postgresql: ['5432/tcp'],
  redis: ['6379/tcp'],
  rsyncd: ['873/tcp', '873/udp'],
  samba: ['137/udp', '138/udp', '139/tcp', '445/tcp'],
  smtp: ['25/tcp'],
  ssh: ['22/tcp'],
  telnet: ['23/tcp'],
  tftp: ['69/udp'],
  vnc_server: ['5900-5903/tcp'],
};
const FIREWALL_ZONES = [
  'block',
  'dmz',
  'drop',
  'external',
  'home',
  'internal',
  'nm-shared',
  'public',
  'trusted',
  'work',
];
const DEFAULT_FIREWALL_SERVICES = ['cockpit', 'dhcpv6-client', 'ssh'];

// ─── DNS (lab nameserver 172.25.250.254) ────────────────────────────────────

const DEFAULT_DNS = {
  'workstation.lab.example.com': WORKSTATION_IP,
  'servera.lab.example.com': '172.25.250.10',
  'serverb.lab.example.com': '172.25.250.11',
  'utility.lab.example.com': '172.25.250.253',
  'bastion.lab.example.com': '172.25.250.254',
  'classroom.example.com': '172.25.254.254',
  'content.example.com': '172.25.254.254',
  'registry.lab.example.com': '172.25.250.253',
  [`api.${CLUSTER_DOMAIN}`]: API_VIP,
  [`api-int.${CLUSTER_DOMAIN}`]: API_VIP,
  'example.com': EXAMPLE_COM_IP,
  'www.example.com': EXAMPLE_COM_IP,
  'example.org': EXAMPLE_COM_IP,
  'example.net': EXAMPLE_COM_IP,
  'registry.access.redhat.com': '23.40.100.203',
  'registry.redhat.io': '23.40.100.211',
  'quay.io': '3.209.157.193',
};
/** Wildcard records: `*.apps.cluster.example.com` → the ingress VIP. */
const DEFAULT_DNS_WILDCARDS = [[APPS_DOMAIN, INGRESS_VIP]];
/** Addresses that answer ping/TCP (everything else in 192.168.50.0/24 is a dead host). */
const REACHABLE_IPS = new Set([
  '127.0.0.1',
  WORKSTATION_IP,
  GATEWAY_IP,
  '172.25.250.10',
  '172.25.250.11',
  '172.25.250.253',
  '172.25.254.254',
  API_VIP,
  INGRESS_VIP,
  EXAMPLE_COM_IP,
  '23.40.100.203',
  '23.40.100.211',
  '3.209.157.193',
]);

// ─── container images (registry catalog for rootless podman) ────────────────

const UBI_OS_RELEASE = OS_RELEASE;

/**
 * Pullable images. `tags` maps tag → image version label. `serves` describes the HTTP
 * answer of a running container on its first exposed port.
 */
const IMAGE_DEFS = [
  {
    repo: 'registry.access.redhat.com/ubi9/ubi',
    tags: ['latest', '9.6', '9.6-1747219013'],
    size: 217,
    created: '2025-05-14T10:42:31Z',
    cmd: ['/bin/bash'],
    user: '0',
    workdir: '/',
    labels: { name: 'ubi9', vendor: 'Red Hat, Inc.', version: '9.6' },
    summary: 'Provides the latest release of Red Hat Universal Base Image 9.',
  },
  {
    repo: 'registry.access.redhat.com/ubi9/ubi-minimal',
    tags: ['latest', '9.6', '9.6-1747218906'],
    size: 104,
    created: '2025-05-14T10:40:12Z',
    cmd: ['/bin/bash'],
    user: '0',
    workdir: '/',
    labels: { name: 'ubi9-minimal', vendor: 'Red Hat, Inc.', version: '9.6' },
    summary: 'Provides the latest release of the minimal Red Hat Universal Base Image 9.',
  },
  {
    repo: 'registry.access.redhat.com/ubi9/httpd-24',
    tags: ['latest', '1', '1-1747200410'],
    size: 376,
    created: '2025-05-14T06:14:39Z',
    cmd: ['/usr/bin/run-httpd'],
    user: '1001',
    workdir: '/opt/app-root/src',
    exposes: [8080, 8443],
    labels: { name: 'ubi9/httpd-24', vendor: 'Red Hat, Inc.', version: '1' },
    summary: 'Platform for running Apache httpd 2.4 or building httpd-based application',
    serves: 'httpd',
    comm: 'httpd',
  },
  {
    repo: 'registry.access.redhat.com/ubi9/nginx-124',
    tags: ['latest', '1', '1-1747200519'],
    size: 341,
    created: '2025-05-14T06:20:02Z',
    cmd: ['nginx', '-g', 'daemon off;'],
    user: '1001',
    workdir: '/opt/app-root/src',
    exposes: [8080, 8443],
    labels: { name: 'ubi9/nginx-124', vendor: 'Red Hat, Inc.', version: '1' },
    summary: 'Platform for running nginx 1.24 or building nginx-based application',
    serves: 'nginx',
    comm: 'nginx',
  },
  {
    repo: 'registry.access.redhat.com/ubi9/python-312',
    tags: ['latest', '1', '1-1747200807'],
    size: 1110,
    created: '2025-05-14T06:31:44Z',
    cmd: ['/bin/sh', '-c', '$STI_SCRIPTS_PATH/usage'],
    user: '1001',
    workdir: '/opt/app-root/src',
    exposes: [8080],
    labels: { name: 'ubi9/python-312', vendor: 'Red Hat, Inc.', version: '1' },
    summary: 'Platform for building and running Python 3.12 applications',
  },
  {
    repo: 'registry.redhat.io/rhel9/mariadb-105',
    tags: ['latest', '1', '1-1747201345'],
    size: 503,
    created: '2025-05-14T06:40:18Z',
    cmd: ['run-mysqld'],
    user: '27',
    workdir: '/opt/app-root/src',
    exposes: [3306],
    labels: { name: 'rhel9/mariadb-105', vendor: 'Red Hat, Inc.', version: '1' },
    summary: 'MariaDB 10.5 SQL database server',
    requiresEnv: ['MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE'],
    comm: 'mysqld',
  },
  {
    repo: 'quay.io/openshift/origin-hello-openshift',
    tags: ['latest'],
    size: 6,
    created: '2018-04-30T19:51:43Z',
    cmd: ['/hello-openshift'],
    user: '1001',
    workdir: '/',
    exposes: [8080, 8888],
    labels: {},
    summary: 'hello-openshift',
    serves: 'hello',
    comm: 'hello-openshift',
  },
];

export const CONTAINER_HTTPD_LOGS = (ip, stamp) => [
  '=> sourcing 10-set-mpm.sh ...',
  '=> sourcing 20-copy-config.sh ...',
  '=> sourcing 40-ssl-certs.sh ...',
  '---> Generating SSL key pair for httpd...',
  `AH00558: httpd: Could not reliably determine the server's fully qualified domain name, using ${ip}. Set the 'ServerName' directive globally to suppress this message`,
  `[${stamp}] [ssl:warn] [pid 1:tid 1] AH01909: ${ip}:8443:0 server certificate does NOT include an ID which matches the server name`,
  `AH00558: httpd: Could not reliably determine the server's fully qualified domain name, using ${ip}. Set the 'ServerName' directive globally to suppress this message`,
  `[${stamp}] [ssl:warn] [pid 1:tid 1] AH01909: ${ip}:8443:0 server certificate does NOT include an ID which matches the server name`,
  `[${stamp}] [lbmethod_heartbeat:notice] [pid 1:tid 1] AH02282: No slotmem from mod_heartmonitor`,
  `[${stamp}] [mpm_event:notice] [pid 1:tid 1] AH00489: Apache/2.4.62 (Red Hat Enterprise Linux) OpenSSL/3.2.2 configured -- resuming normal operations`,
  `[${stamp}] [core:notice] [pid 1:tid 1] AH00094: Command line: 'httpd -D FOREGROUND'`,
];

/** Apache section tags (`<Directory …>`) the validator accepts. */
const HTTPD_SECTIONS = new Set([
  'directory',
  'directorymatch',
  'files',
  'filesmatch',
  'location',
  'locationmatch',
  'virtualhost',
  'ifmodule',
  'ifdefine',
  'iffile',
  'ifversion',
  'ifdirective',
  'ifsection',
  'requireall',
  'requireany',
  'requirenone',
  'limit',
  'limitexcept',
  'proxy',
  'proxymatch',
  'if',
  'elseif',
  'else',
  'authnprovideralias',
  'macro',
]);

/** Directives of the modules RHEL 9 httpd loads by default (case-insensitive). */
const HTTPD_DIRECTIVES = new Set(
  `AcceptFilter AcceptPathInfo AccessFileName Action AddAlt AddAltByEncoding AddAltByType AddCharset
  AddDefaultCharset AddDescription AddEncoding AddHandler AddIcon AddIconByEncoding AddIconByType
  AddInputFilter AddLanguage AddOutputFilter AddOutputFilterByType AddType Alias AliasMatch Allow
  AllowEncodedSlashes AllowMethods AllowOverride AllowOverrideList AuthBasicProvider AuthGroupFile
  AuthName AuthType AuthUserFile BrowserMatch BrowserMatchNoCase CacheEnable CustomLog DAV
  DefaultIcon DefaultLanguage DefaultRuntimeDir DefaultType Define Deny DirectoryIndex
  DirectorySlash DocumentRoot EnableMMAP EnableSendfile Error ErrorDocument ErrorLog ErrorLogFormat
  ExpiresActive ExpiresByType ExpiresDefault ExtendedStatus FallbackResource FileETag ForceType
  Group H2Direct Header HeaderName HostnameLookups HttpProtocolOptions Include IncludeOptional
  IndexIgnore IndexOptions IndexOrderDefault IndexStyleSheet KeepAlive KeepAliveTimeout
  LimitInternalRecursion LimitRequestBody LimitRequestFields LimitRequestFieldSize
  LimitRequestLine Listen ListenBacklog LoadFile LoadModule LogFormat LogLevel MaxClients
  MaxConnectionsPerChild MaxKeepAliveRequests MaxRequestWorkers MaxSpareServers MaxSpareThreads
  MIMEMagicFile MinSpareServers MinSpareThreads Mutex NameVirtualHost Options Order PassEnv
  PidFile Protocols ProxyErrorOverride ProxyPass ProxyPassMatch ProxyPassReverse ProxyPreserveHost
  ProxyRequests ProxyTimeout ReadmeName Redirect RedirectMatch RedirectPermanent RedirectTemp
  RemoveHandler RemoveType RequestHeader Require RewriteBase RewriteCond RewriteEngine RewriteMap
  RewriteOptions RewriteRule Satisfy ScriptAlias ScriptAliasMatch ScriptLog ServerAdmin
  ServerAlias ServerLimit ServerName ServerPath ServerRoot ServerSignature ServerTokens SetEnv
  SetEnvIf SetEnvIfNoCase SetHandler SetInputFilter SetOutputFilter SSLCACertificateFile
  SSLCertificateChainFile SSLCertificateFile SSLCertificateKeyFile SSLCipherSuite SSLEngine
  SSLHonorCipherOrder SSLPassPhraseDialog SSLProtocol SSLProxyEngine SSLRandomSeed
  SSLSessionCache SSLSessionCacheTimeout SSLCryptoDevice StartServers ThreadLimit ThreadsPerChild
  Timeout TraceEnable TypesConfig UnDefine UnsetEnv UseCanonicalName User UserDir`
    .split(/\s+/)
    .filter(Boolean)
    .map((name) => name.toLowerCase())
);

/** sshd_config keywords (OpenSSH 8.7, lower-case). */
const SSHD_KEYWORDS = new Set(
  `acceptenv addressfamily allowagentforwarding allowgroups allowstreamlocalforwarding
  allowtcpforwarding allowusers authenticationmethods authorizedkeyscommand
  authorizedkeyscommanduser authorizedkeysfile authorizedprincipalscommand
  authorizedprincipalscommanduser authorizedprincipalsfile banner casignaturealgorithms
  challengeresponseauthentication chrootdirectory ciphers clientalivecountmax clientaliveinterval
  compression denygroups denyusers disableforwarding exposeauthinfo fingerprinthash forcecommand
  gatewayports gssapiauthentication gssapicleanupcredentials gssapienablek5users
  gssapikeyexchange gssapistrictacceptorcheck hostbasedacceptedalgorithms hostbasedauthentication
  hostcertificate hostkey hostkeyagent hostkeyalgorithms ignorerhosts ignoreuserknownhosts include
  ipqos kbdinteractiveauthentication kerberosauthentication kexalgorithms listenaddress
  logingracetime loglevel logverbose macs match maxauthtries maxsessions maxstartups
  passwordauthentication permitemptypasswords permitlisten permitopen permitrootlogin
  permittty permittunnel permituserenvironment permituserrc pidfile port printlastlog printmotd
  pubkeyacceptedalgorithms pubkeyauthentication rekeylimit revokedkeys securitykeyprovider
  setenv streamlocalbindmask streamlocalbindunlink strictmodes subsystem syslogfacility tcpkeepalive
  trustedusercakeys usedns usepam versionaddendum x11displayoffset x11forwarding x11uselocalhost
  xauthlocation`
    .split(/\s+/)
    .filter(Boolean)
);

/** Signal numbers ↔ names (`kill -l`, `kill -SIGTERM`). */
export const SIGNAL_NAMES = {
  1: 'HUP',
  2: 'INT',
  3: 'QUIT',
  4: 'ILL',
  5: 'TRAP',
  6: 'ABRT',
  7: 'BUS',
  8: 'FPE',
  9: 'KILL',
  10: 'USR1',
  11: 'SEGV',
  12: 'USR2',
  13: 'PIPE',
  14: 'ALRM',
  15: 'TERM',
  16: 'STKFLT',
  17: 'CHLD',
  18: 'CONT',
  19: 'STOP',
  20: 'TSTP',
  21: 'TTIN',
  22: 'TTOU',
  23: 'URG',
  24: 'XCPU',
  25: 'XFSZ',
  26: 'VTALRM',
  27: 'PROF',
  28: 'WINCH',
  29: 'IO',
  30: 'PWR',
  31: 'SYS',
};

// ─── VFS mapping (home + /tmp contents live in the ManifestEngine store) ────

function isVfsArea(abs) {
  return isUnder(abs, HOME) || isUnder(abs, '/tmp');
}

/**
 * ManifestEngine key for an absolute path in the home/tmp areas (`''` = the home directory
 * itself, `tmp/x` = `/tmp/x`, exactly the mapping the terminal used before 1.16.0), or null.
 */
export function vfsKeyFor(path) {
  const abs = normalizePath(path);
  if (abs === '/tmp') return 'tmp';
  if (abs.startsWith('/tmp/')) return abs.slice(1);
  if (abs === HOME) return '';
  if (abs.startsWith(`${HOME}/`)) return abs.slice(HOME.length + 1);
  return null;
}

/** Absolute workstation path of a ManifestEngine key (inverse of vfsKeyFor). */
export function pathForVfsKey(key) {
  const clean = String(key ?? '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (!clean || clean === '.') return HOME;
  if (clean === 'tmp' || clean.startsWith('tmp/')) return normalizePath(`/${clean}`);
  return normalizePath(`${HOME}/${clean}`);
}

/** Prefix of the editable copies `vim`/`nano` open in the Files panel for non-VFS files. */
export const MIRROR_PREFIX = '.oc/host';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function parseEvr(evr) {
  const text = String(evr || '');
  const colon = text.indexOf(':');
  const epoch = colon > 0 ? text.slice(0, colon) : '';
  const rest = colon > 0 ? text.slice(colon + 1) : text;
  const dash = rest.lastIndexOf('-');
  return {
    epoch,
    version: dash > 0 ? rest.slice(0, dash) : rest,
    release: dash > 0 ? rest.slice(dash + 1) : '',
  };
}

// ─── the host ───────────────────────────────────────────────────────────────

export class LinuxHost {
  /**
   * @param {{fileStore?: Function|object, clock?: Function, seed?: object}} [options]
   *   `fileStore`: the ManifestEngine (or a function returning it) holding home/tmp contents.
   */
  constructor(options = {}) {
    this.setFileStore(options.fileStore ?? null);
    this.clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
    /** Bumped on every reset so callers can notice a fresh machine. */
    this.generation = 0;
    this.reset(options.seed ?? null);
  }

  /** Attach the virtual file store (ManifestEngine) — a value or a provider function. */
  setFileStore(store) {
    if (typeof store === 'function') this._fileStoreProvider = store;
    else if (store && typeof store === 'object') this._fileStoreProvider = () => store;
    else this._fileStoreProvider = null;
    return this;
  }

  now() {
    const value = Number(this.clock());
    return Number.isFinite(value) ? value : Date.now();
  }

  /**
   * Restore the default workstation and apply a level seed (`levelDef.linuxHost`, schema in
   * /tmp/osg-team/LINUX-SCHEMA.md). `reset(null)` is the default machine.
   * @param {object|null} [seed]
   * @returns {LinuxHost}
   */
  reset(seed = null) {
    // Lazy: nothing is built until the first access to host state (a shell command, a file
    // access through the CLI, or a Linux objective), so boot, mode launches and OpenShift-only
    // play never pay for the workstation (see LAZY_STATE_FIELDS below the class).
    this.generation += 1;
    this._lazySeed = seed;
    this._lazyPending = true;
    // A level seed (Linux levels) changes the Files panel: apply it now, not on first use.
    if (seed && typeof seed === 'object') this.materialize();
    return this;
  }

  /** Run a deferred `reset()` now (idempotent). */
  materialize() {
    if (this._lazyPending) {
      this._lazyPending = false;
      this._build(this._lazySeed ?? null);
      this._lazySeed = null;
    }
    return this;
  }

  /** Build the default workstation, then apply the seed (the body of a deferred reset). */
  _build(seed) {
    const now = this.now();
    this.resetAt = now;
    this.bootTime = now - BOOT_AGE_MS;
    this.installTime = INSTALL_TIME_MS;
    /** Default mtime of files that were already in the Files panel at level start. */
    this.vfsBaseTime = now - 47 * 60 * 1000;
    this.hostname = HOSTNAME_FQDN;
    this.nodes = new Map();
    this._pendingVfs = new Set();
    /** Seed `remove` paths in home/tmp waiting for the Files store (first launch). */
    this._deferredRemovals = [];
    this.mirrors = new Map();
    this.selinux = {
      mode: 'enforcing',
      fcontext: [],
      ports: clone(DEFAULT_PORT_TYPES),
      denials: [],
    };
    this.users = new Map();
    this.groups = new Map();
    this.shadow = new Map();
    this.catalog = new Map();
    this.installed = new Map();
    this.units = new Map();
    this.journal = [];
    this.processes = new Map();
    this.nextPid = 3100;
    this.nextJobId = 1290;
    this.firewall = {
      running: true,
      defaultZone: 'public',
      runtime: { public: { services: new Set(DEFAULT_FIREWALL_SERVICES), ports: new Set() } },
      permanent: { public: { services: new Set(DEFAULT_FIREWALL_SERVICES), ports: new Set() } },
    };
    this.dns = new Map(Object.entries(DEFAULT_DNS));
    this.dnsWildcards = DEFAULT_DNS_WILDCARDS.map((entry) => [...entry]);
    this.reachable = new Set(REACHABLE_IPS);
    this.registry = new Map();
    this.podman = { student: this._emptyPodmanStore(), root: this._emptyPodmanStore() };
    this.execLog = [];
    this.httpLog = [];
    this.timeSync = { ntpEnabled: true };
    this.session = {
      user: 'student',
      cwd: HOME,
      oldpwd: null,
      stack: [],
      env: new Map(),
      vars: new Map(),
      umask: 0o022,
      aliases: new Map(),
    };
    this._buildAccounts();
    this._buildCatalog();
    this._buildTree();
    this._buildUnits();
    this._buildRegistry();
    this._bootJournal();
    if (seed && typeof seed === 'object') this.applySeed(seed);
    return this;
  }

  // ── accounts ─────────────────────────────────────────────────────────────

  _buildAccounts() {
    for (const [name, uid, gid, gecos, home, shell] of DEFAULT_USERS) {
      this.users.set(name, { name, uid, gid, gecos, home, shell });
      const hash = SHADOW_HASH[name] || (uid === 0 || uid >= 1000 ? '!!' : '*');
      this.shadow.set(name, { hash, lastChange: 20304, min: 0, max: 99999, warn: 7 });
    }
    for (const [name, gid, members] of DEFAULT_GROUPS) {
      this.groups.set(name, { name, gid, members: new Set(members) });
    }
  }

  /** `{name, uid, gid, gids:Set, home, shell, isRoot}` or null. */
  identity(name = this.session.user) {
    const user = this.users.get(String(name));
    if (!user) return null;
    const gids = new Set([user.gid]);
    for (const group of this.groups.values()) if (group.members.has(user.name)) gids.add(group.gid);
    return {
      name: user.name,
      uid: user.uid,
      gid: user.gid,
      gids,
      home: user.home,
      shell: user.shell,
      isRoot: user.uid === 0,
    };
  }

  userByUid(uid) {
    for (const user of this.users.values()) if (user.uid === Number(uid)) return user;
    return null;
  }

  groupByGid(gid) {
    for (const group of this.groups.values()) if (group.gid === Number(gid)) return group;
    return null;
  }

  userName(uid) {
    return this.userByUid(uid)?.name ?? String(uid);
  }

  groupName(gid) {
    return this.groupByGid(gid)?.name ?? String(gid);
  }

  /** Supplementary + primary group names of a user, primary first (like `id -Gn`). */
  groupsOf(name) {
    const user = this.users.get(String(name));
    if (!user) return [];
    const primary = this.groupByGid(user.gid);
    const names = primary ? [primary.name] : [String(user.gid)];
    const others = [...this.groups.values()]
      .filter((group) => group.members.has(user.name) && group.gid !== user.gid)
      .sort((a, b) => a.gid - b.gid)
      .map((group) => group.name);
    return [...names, ...others];
  }

  _uidOf(owner) {
    if (typeof owner === 'number') return owner;
    const user = this.users.get(String(owner));
    if (user) return user.uid;
    return /^\d+$/.test(String(owner)) ? Number(owner) : 0;
  }

  _gidOf(group) {
    if (typeof group === 'number') return group;
    const entry = this.groups.get(String(group));
    if (entry) return entry.gid;
    const user = this.users.get(String(group));
    if (user) return user.gid;
    return /^\d+$/.test(String(group)) ? Number(group) : 0;
  }

  /**
   * Add (or replace) an account. Creates the private group unless `gid` names an existing
   * group, and the home directory (skel dotfiles, mode 0700) unless `createHome === false`.
   */
  addUser(spec = {}) {
    const name = String(spec.name || '').trim();
    if (!name) return null;
    let uid = Number.isFinite(Number(spec.uid)) ? Number(spec.uid) : null;
    if (uid === null) {
      uid = 1000;
      for (const user of this.users.values())
        if (user.uid >= uid && user.uid < 60000) uid = user.uid + 1;
    }
    let gid = Number.isFinite(Number(spec.gid)) ? Number(spec.gid) : null;
    if (spec.group && this.groups.has(spec.group)) gid = this.groups.get(spec.group).gid;
    if (gid === null || !this.groupByGid(gid)) {
      const wanted = gid ?? uid;
      if (!this.groups.has(name)) this.groups.set(name, { name, gid: wanted, members: new Set() });
      gid = this.groups.get(name).gid;
    }
    const home = spec.home || `/home/${name}`;
    const user = {
      name,
      uid,
      gid,
      gecos: spec.comment ?? spec.gecos ?? '',
      home,
      shell: spec.shell || '/bin/bash',
    };
    this.users.set(name, user);
    this.shadow.set(name, {
      hash: spec.password
        ? `$6$${fakeSha256(`salt-${name}`).slice(0, 16)}$${fakeSha256(`${name}:${spec.password}`)}`
        : spec.locked
          ? '!!'
          : '!!',
      lastChange: Math.floor(this.now() / 86400000),
      min: 0,
      max: 99999,
      warn: 7,
    });
    for (const groupName of spec.groups || []) {
      const group = this.groups.get(String(groupName));
      if (group) group.members.add(name);
    }
    if (spec.createHome !== false && !this.nodes.has(home) && !isUnder(home, HOME)) {
      this._mk(home, { mode: 0o700, owner: uid, group: gid, mtime: this.now() });
      for (const [file, content] of [
        ['.bash_logout', SKEL_BASH_LOGOUT],
        ['.bash_profile', SKEL_BASH_PROFILE],
        ['.bashrc', SKEL_BASHRC],
      ]) {
        this._mk(`${home}/${file}`, { content, owner: uid, group: gid, mtime: this.now() });
      }
    }
    return user;
  }

  addGroup(spec = {}) {
    const name = String(spec.name || '').trim();
    if (!name) return null;
    let gid = Number.isFinite(Number(spec.gid)) ? Number(spec.gid) : null;
    if (gid === null) {
      gid = 1000;
      for (const group of this.groups.values())
        if (group.gid >= gid && group.gid < 60000) gid = group.gid + 1;
    }
    const group = { name, gid, members: new Set((spec.members || []).map(String)) };
    this.groups.set(name, group);
    return group;
  }

  // ── node helpers ─────────────────────────────────────────────────────────

  /** SELinux context a new file gets at `abs` (fcontext rules + local rules first). */
  defaultContext(abs, seuser = 'system_u') {
    const type = this.defaultContextType(abs);
    return `${seuser}:object_r:${type}:s0`;
  }

  defaultContextType(abs) {
    for (const rule of this.selinux?.fcontext || []) {
      if (rule.regex.test(abs)) return rule.type;
    }
    for (const [regex, type] of FCONTEXT_RULES) if (regex.test(abs)) return type;
    return 'default_t';
  }

  /** Create/replace a host node (no permission checks). */
  _mk(path, spec = {}) {
    const abs = normalizePath(path);
    const type =
      spec.type ||
      (spec.target !== undefined
        ? 'link'
        : spec.content !== undefined || spec.generator || spec.binary
          ? 'file'
          : 'dir');
    this._ensureParents(abs, spec.parentOwner);
    const node = {
      type,
      mode:
        spec.mode ??
        (type === 'dir' ? 0o755 : type === 'link' ? 0o777 : spec.binary ? 0o755 : 0o644),
      uid: this._uidOf(spec.owner ?? 'root'),
      gid: this._gidOf(spec.group ?? spec.owner ?? 'root'),
      mtime: spec.mtime ?? this.installTime,
      context:
        spec.context ||
        this.defaultContext(abs, spec.seuser || (isUnder(abs, HOME) ? 'unconfined_u' : 'system_u')),
    };
    if (type === 'file') {
      node.content = spec.content ?? '';
      if (spec.generator) node.generator = spec.generator;
      if (spec.binary) {
        node.binary = true;
        node.size = spec.size ?? 4096 + (fnv1a(abs) % 150000);
      }
    }
    if (type === 'link') node.target = String(spec.target);
    if (type === 'char' || type === 'block') node.rdev = spec.rdev || [1, 3];
    if (spec.hostOnly) node.hostOnly = true;
    if (spec.owner === undefined && isUnder(abs, HOME) && abs !== HOME) {
      node.uid = 1000;
      node.gid = 1000;
    }
    this.nodes.set(abs, node);
    return node;
  }

  _ensureParents(abs, owner) {
    let current = dirnameOf(abs);
    const missing = [];
    while (current !== '/' && !this.nodes.has(current)) {
      missing.unshift(current);
      current = dirnameOf(current);
    }
    for (const dir of missing) {
      const inHome = isUnder(dir, HOME);
      this.nodes.set(dir, {
        type: 'dir',
        mode: 0o755,
        uid: owner !== undefined ? this._uidOf(owner) : inHome ? 1000 : 0,
        gid: owner !== undefined ? this._gidOf(owner) : inHome ? 1000 : 0,
        mtime: this.installTime,
        context: this.defaultContext(dir, inHome ? 'unconfined_u' : 'system_u'),
      });
    }
  }

  _defaultVfsMeta(abs, type) {
    return {
      type,
      mode: type === 'dir' ? 0o755 : 0o644,
      uid: 1000,
      gid: 1000,
      mtime: this.vfsBaseTime,
      context: this.defaultContext(abs, 'unconfined_u'),
      implicit: true,
    };
  }

  // ── virtual file store (ManifestEngine) ──────────────────────────────────

  _store() {
    let store = null;
    try {
      store = this._fileStoreProvider ? this._fileStoreProvider() : null;
    } catch {
      store = null;
    }
    if (
      !store ||
      typeof store.readFile !== 'function' ||
      typeof store.writeFile !== 'function' ||
      typeof store.listFiles !== 'function'
    )
      return null;
    if ((this._pendingVfs.size || this._deferredRemovals?.length) && !this._flushing) {
      this._flushPending(store);
    }
    return store;
  }

  _storeRead(store, key) {
    if (!key) return null;
    try {
      const value = store.readFile(key);
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  }

  _storeKeys(store) {
    try {
      const list = store.listFiles();
      const entries = Array.isArray(list) ? list : Array.isArray(list?.files) ? list.files : [];
      return entries
        .map((entry) => (typeof entry === 'string' ? entry : entry?.path || entry?.name || ''))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Home/tmp files written while no store existed move into the store once it appears. */
  _flushPending(store) {
    this._flushing = true;
    let moved = 0;
    try {
      // Seed removals first (the store's default lab files arrived after the seed), then
      // the seeded files — the same order as applySeed().
      const removals = this._deferredRemovals || [];
      this._deferredRemovals = [];
      for (const abs of removals) {
        const key = vfsKeyFor(abs);
        if (!key) continue;
        for (const candidate of this._storeKeys(store)) {
          if (candidate !== key && !candidate.startsWith(`${key}/`)) continue;
          if (this._pendingVfs.has(pathForVfsKey(candidate))) continue;
          try {
            store.deleteFile?.(candidate);
            moved += 1;
          } catch {
            /* keep going */
          }
        }
      }
      for (const abs of [...this._pendingVfs]) {
        const node = this.nodes.get(abs);
        this._pendingVfs.delete(abs);
        if (!node || node.type !== 'file' || node.hostOnly) continue;
        const key = vfsKeyFor(abs);
        if (!key) continue;
        try {
          store.writeFile(key, node.content ?? '');
        } catch {
          continue;
        }
        node.vfs = true;
        delete node.content;
        moved += 1;
      }
    } finally {
      this._flushing = false;
    }
    // The Files panel reads the store directly: show the level's files right away.
    if (moved && typeof window !== 'undefined') {
      try {
        window.game?.manifestPanel?.refresh?.();
      } catch {
        /* the panel is optional */
      }
    }
  }

  /**
   * A level seeded before the Files panel exists (first launch: the panel and its
   * ManifestEngine are created after `startLevel`) keeps its home files pending; poll
   * briefly for the store so they appear in the Files panel without any command.
   */
  _scheduleFlush() {
    if (this._flushTimer || typeof setTimeout !== 'function') return;
    let attempts = 0;
    const tick = () => {
      this._flushTimer = null;
      if ((!this._pendingVfs.size && !this._deferredRemovals?.length) || this._store()) return;
      attempts += 1;
      if (attempts > 240) return;
      this._flushTimer = setTimeout(tick, 250);
      this._flushTimer?.unref?.();
    };
    this._flushTimer = setTimeout(tick, 250);
    this._flushTimer?.unref?.();
  }

  /** Write editable `vim` copies (`.oc/host/<path>`) back to their real path. */
  _syncMirrors() {
    if (!this.mirrors.size) return;
    const store = this._store();
    if (!store) return;
    for (const [key, mirror] of this.mirrors) {
      const text = this._storeRead(store, key);
      if (text === null) {
        this.mirrors.delete(key);
        continue;
      }
      if (text === mirror.synced) continue;
      mirror.synced = text;
      const node = this._lookup(mirror.path);
      if (node && node.type === 'file') this._setContent(mirror.path, node, text);
    }
  }

  /** Bring derived state up to date before any read (mirrors, pending store writes). */
  sync() {
    this._store();
    this._syncMirrors();
    return this;
  }

  /**
   * Node at an absolute path WITHOUT following a final symlink and without permission
   * checks. Home/tmp files are served from the store with their overlay metadata.
   */
  _lookup(path) {
    const abs = normalizePath(path);
    if (abs === `${HOME}/tmp`) {
      // Legacy alias: the Files panel shows /tmp as `tmp/` inside the home directory.
      return {
        type: 'link',
        target: '/tmp',
        mode: 0o777,
        uid: 0,
        gid: 0,
        mtime: this.installTime,
        context: 'system_u:object_r:tmp_t:s0',
        hidden: true,
      };
    }
    const node = this.nodes.get(abs) || null;
    if (abs === HOME || abs === '/tmp' || !isVfsArea(abs)) return node;
    if (node && (node.hostOnly || (node.type !== 'file' && !node.implicit))) return node;
    const store = this._store();
    if (!store) return node;
    const key = vfsKeyFor(abs);
    const content = this._storeRead(store, key);
    if (content !== null) {
      const meta = node && node.type === 'file' ? node : this._defaultVfsMeta(abs, 'file');
      return { ...meta, type: 'file', vfs: true, key, content, size: byteLength(content) };
    }
    if (node && node.vfs) this.nodes.delete(abs);
    else if (node) return node;
    const prefix = `${key}/`;
    if (this._storeKeys(store).some((candidate) => candidate.startsWith(prefix))) {
      return this._defaultVfsMeta(abs, 'dir');
    }
    return null;
  }

  /** Immediate child names of a directory (host nodes + store keys), unsorted. */
  _childNames(abs) {
    const names = new Set();
    const prefix = abs === '/' ? '/' : `${abs}/`;
    for (const path of this.nodes.keys()) {
      if (!path.startsWith(prefix) || path === abs) continue;
      const rest = path.slice(prefix.length);
      if (rest && !rest.includes('/')) names.add(rest);
    }
    if (isVfsArea(abs) && abs !== `${HOME}/tmp`) {
      const store = this._store();
      if (store) {
        const key = vfsKeyFor(abs);
        const keyPrefix = key ? `${key}/` : '';
        for (const candidate of this._storeKeys(store)) {
          if (keyPrefix && !candidate.startsWith(keyPrefix)) continue;
          const rest = candidate.slice(keyPrefix.length);
          if (!rest) continue;
          const first = rest.split('/')[0];
          if (abs === HOME && first === 'tmp') continue;
          names.add(first);
        }
      }
    }
    return [...names].filter((name) => {
      const node = this._lookup(abs === '/' ? `/${name}` : `${abs}/${name}`);
      return node && !node.hidden;
    });
  }

  /**
   * Resolve an absolute path component by component: every directory on the way must be
   * searchable (x) by `ident` (null = no checks); symlinks are followed (the final one
   * only when `follow`).
   * @returns {{path: string, node: object|null, parentPath?: string, parentNode?: object|null, error?: string}}
   */
  _walk(path, ident, follow = true, depth = 0) {
    const abs = normalizePath(path);
    if (abs === '/')
      return { path: '/', node: this._lookup('/'), parentPath: '/', parentNode: null };
    const parts = abs.split('/').filter(Boolean);
    let current = '/';
    let node = this._lookup('/');
    for (let index = 0; index < parts.length; index += 1) {
      if (!node) return { error: 'ENOENT', path: abs };
      if (node.type !== 'dir') return { error: 'ENOTDIR', path: abs };
      if (ident && !this._can(node, ident, 1)) return { error: 'EACCES', path: abs };
      const next = current === '/' ? `/${parts[index]}` : `${current}/${parts[index]}`;
      const child = this._lookup(next);
      const last = index === parts.length - 1;
      if (child && child.type === 'link' && (!last || follow)) {
        if (depth > 8) return { error: 'ELOOP', path: abs };
        const target = child.target.startsWith('/')
          ? child.target
          : `${current === '/' ? '' : current}/${child.target}`;
        const rest = parts.slice(index + 1).join('/');
        return this._walk(
          normalizePath(rest ? `${target}/${rest}` : target),
          ident,
          follow,
          depth + 1
        );
      }
      if (!child) {
        if (last) return { path: next, node: null, parentPath: current, parentNode: node };
        return { error: 'ENOENT', path: abs };
      }
      if (last) return { path: next, node: child, parentPath: current, parentNode: node };
      current = next;
      node = child;
    }
    return {
      path: current,
      node,
      parentPath: dirnameOf(current),
      parentNode: this._lookup(dirnameOf(current)),
    };
  }

  /** DAC check (`want`: 4 read, 2 write, 1 exec/search). Root bypasses all but exec. */
  _can(node, ident, want) {
    if (!ident || !node) return true;
    if (ident.uid === 0) {
      if (want & 1 && node.type !== 'dir') return Boolean(node.mode & 0o111);
      return true;
    }
    let bits;
    if (node.uid === ident.uid) bits = (node.mode >> 6) & 7;
    else if (ident.gids.has(node.gid)) bits = (node.mode >> 3) & 7;
    else bits = node.mode & 7;
    return (bits & want) === want;
  }

  _ident(user) {
    return this.identity(user ?? this.session.user) || this.identity('student');
  }

  /** Content of a file node (generated files render from the model). */
  _content(path, node) {
    if (!node) return '';
    if (node.type === 'char') return '';
    if (node.generator) return this._generate(node.generator, path);
    if (node.binary) return '\u007fELF\u0002\u0001\u0001\u0000';
    return node.content ?? '';
  }

  /** Replace a file's content (store for home/tmp files, else the node). */
  _setContent(path, node, content) {
    const abs = normalizePath(path);
    const now = this.now();
    if (node.generator) {
      this._acceptGenerated(node.generator, abs, String(content));
      return;
    }
    if (node.vfs) {
      const store = this._store();
      if (store) {
        try {
          store.writeFile(node.key || vfsKeyFor(abs), String(content));
        } catch {
          /* store refused; keep the overlay consistent anyway */
        }
      }
      const meta = this.nodes.get(abs) || { ...node };
      delete meta.content;
      delete meta.key;
      delete meta.size;
      delete meta.implicit;
      meta.vfs = true;
      meta.mtime = now;
      this.nodes.set(abs, meta);
      return;
    }
    const target = this.nodes.get(abs);
    if (target) {
      target.content = String(content);
      target.mtime = now;
      if (target.binary) {
        delete target.binary;
        delete target.size;
      }
    }
  }

  /** Create a regular file (no permission checks), honouring the store for home/tmp. */
  _createFile(path, content, { uid = 0, gid = 0, mode = 0o644, context, mtime, hostOnly } = {}) {
    const abs = normalizePath(path);
    const now = mtime ?? this.now();
    const meta = {
      type: 'file',
      mode,
      uid,
      gid,
      mtime: now,
      context:
        context ||
        this.defaultContext(abs, uid === 0 && !isVfsArea(abs) ? 'system_u' : 'unconfined_u'),
    };
    if (isVfsArea(abs) && !hostOnly) {
      const store = this._store();
      if (store) {
        try {
          store.writeFile(vfsKeyFor(abs), String(content ?? ''));
          meta.vfs = true;
          this.nodes.set(abs, meta);
          return meta;
        } catch {
          /* fall back to a host node */
        }
      }
      meta.content = String(content ?? '');
      this.nodes.set(abs, meta);
      this._pendingVfs.add(abs);
      this._scheduleFlush();
      return meta;
    }
    meta.content = String(content ?? '');
    if (hostOnly) meta.hostOnly = true;
    this.nodes.set(abs, meta);
    return meta;
  }

  /** Remove a node (and a store file for home/tmp), keeping its parent directory alive. */
  _deleteNode(path, node) {
    const abs = normalizePath(path);
    const parent = dirnameOf(abs);
    // A directory that only existed because of its files must survive losing the last one.
    const parentNode = this._lookup(parent);
    if (parentNode && parentNode.implicit && isVfsArea(parent)) {
      this.nodes.set(parent, { ...parentNode, implicit: false });
      delete this.nodes.get(parent).implicit;
    }
    if (node?.vfs) {
      const store = this._store();
      try {
        if (store && typeof store.deleteFile === 'function')
          store.deleteFile(node.key || vfsKeyFor(abs));
      } catch {
        /* ignore */
      }
    }
    this.nodes.delete(abs);
    this._pendingVfs.delete(abs);
  }

  /** Persisted metadata node for chmod/chown/touch (materialises implicit home dirs). */
  _metaNode(path, node) {
    const abs = normalizePath(path);
    let target = this.nodes.get(abs);
    if (!target) {
      target = { ...node };
      delete target.content;
      delete target.key;
      delete target.size;
      delete target.implicit;
      if (node.type === 'file' && node.vfs) target.vfs = true;
      this.nodes.set(abs, target);
    } else if (target.implicit) delete target.implicit;
    return target;
  }

  // ── path resolution (the ONE resolver shared by ShellTools and CommandBar) ─

  /** Home directory of a user (falls back to /home/<name>). */
  homeOf(name = this.session.user) {
    return this.users.get(String(name))?.home || (name === 'root' ? '/root' : `/home/${name}`);
  }

  /**
   * Absolute path for a typed path: `~`, `~/x`, `~user/x`, absolute or relative to `cwd`
   * (default: the shell's working directory). Purely lexical (`..` collapses), like bash.
   */
  resolvePath(input, { cwd } = {}) {
    let text = String(input ?? '');
    const base = cwd || this.session.cwd || HOME;
    if (text === '') return normalizePath(base);
    if (text === '~' || text.startsWith('~/'))
      text = `${this.homeOf(this.session.user)}${text.slice(1)}`;
    else {
      const match = text.match(/^~([a-z_][a-z0-9_.-]*)(\/.*)?$/i);
      if (match && this.users.has(match[1])) text = `${this.homeOf(match[1])}${match[2] || ''}`;
    }
    if (!text.startsWith('/')) text = `${base === '/' ? '' : base}/${text}`;
    return normalizePath(text);
  }

  /** ManifestEngine key for a typed path, or null when it is outside home/tmp. */
  vfsKey(input, options = {}) {
    const abs = this.resolvePath(input, options);
    if (abs === `${HOME}/tmp` || abs.startsWith(`${HOME}/tmp/`))
      return `tmp${abs.slice(`${HOME}/tmp`.length)}`;
    return vfsKeyFor(abs);
  }

  // ── public filesystem API (permission-checked; `user` defaults to the shell user) ─

  /** stat(2)/lstat(2): `{ok, path, node}` or `{error, path}`. */
  stat(input, { user, follow = true, cwd } = {}) {
    this.sync();
    const abs = this.resolvePath(input, { cwd });
    const walked = this._walk(abs, this._ident(user), follow);
    if (walked.error) return { error: walked.error, path: abs };
    if (!walked.node) return { error: 'ENOENT', path: abs };
    return { ok: true, path: walked.path, node: walked.node, parentNode: walked.parentNode };
  }

  exists(input, options = {}) {
    return Boolean(this.stat(input, { ...options, user: 'root' }).ok);
  }

  /** read(2) a whole file: `{ok, content, path, node}` or `{error, path}`. */
  readFile(input, { user, cwd } = {}) {
    this.sync();
    const abs = this.resolvePath(input, { cwd });
    const ident = this._ident(user);
    const walked = this._walk(abs, ident, true);
    if (walked.error) return { error: walked.error, path: abs };
    if (!walked.node) return { error: 'ENOENT', path: abs };
    if (walked.node.type === 'dir') return { error: 'EISDIR', path: abs };
    if (!this._can(walked.node, ident, 4)) return { error: 'EACCES', path: abs };
    return {
      ok: true,
      content: this._content(walked.path, walked.node),
      path: walked.path,
      node: walked.node,
    };
  }

  /**
   * open(O_WRONLY|O_CREAT[|O_APPEND]) + write: creates the file with the caller's owner,
   * umask'd mode and the parent's SELinux type. `{ok, path, created}` or `{error, path}`.
   */
  writeFile(input, content, { user, cwd, append = false, mode } = {}) {
    this.sync();
    const abs = this.resolvePath(input, { cwd });
    const ident = this._ident(user);
    const walked = this._walk(abs, ident, true);
    if (walked.error) return { error: walked.error, path: abs };
    const text = String(content ?? '');
    if (walked.node) {
      const node = walked.node;
      if (node.type === 'dir') return { error: 'EISDIR', path: abs };
      if (node.type === 'char') return { ok: true, path: walked.path, created: false };
      if (!this._can(node, ident, 2)) return { error: 'EACCES', path: abs };
      const next = append ? `${this._content(walked.path, node)}${text}` : text;
      this._setContent(walked.path, node, next);
      return { ok: true, path: walked.path, created: false };
    }
    const parent = walked.parentNode;
    if (!parent) return { error: 'ENOENT', path: abs };
    if (parent.type !== 'dir') return { error: 'ENOTDIR', path: abs };
    if (!this._can(parent, ident, 3)) return { error: 'EACCES', path: abs };
    const gid = parent.mode & 0o2000 ? parent.gid : ident.gid;
    this._createFile(walked.path, text, {
      uid: ident.uid,
      gid,
      mode: (mode ?? 0o666) & ~this.session.umask,
      context: this._newContext(walked.path, parent, ident),
      hostOnly: Boolean(parent.hostOnly) && !isVfsArea(walked.path),
    });
    return { ok: true, path: walked.path, created: true };
  }

  /** SELinux label of a new file: the creator's SELinux user + the parent's type. */
  _newContext(abs, parent, ident) {
    const seuser = ident && ident.uid >= 1000 ? 'unconfined_u' : 'unconfined_u';
    if (isUnder(abs, '/tmp') && abs !== '/tmp') return `${seuser}:object_r:user_tmp_t:s0`;
    const parentType = String(parent?.context || '').split(':')[2];
    const type =
      parentType === 'user_home_dir_t' ? 'user_home_t' : parentType || this.defaultContextType(abs);
    return `${seuser}:object_r:${type}:s0`;
  }

  /** mkdir(2) [+ -p parents]: `{ok, created: string[]}` or `{error, path}`. */
  mkdir(input, { user, cwd, parents = false, mode } = {}) {
    this.sync();
    const abs = this.resolvePath(input, { cwd });
    const ident = this._ident(user);
    const created = [];
    const chain = parents ? [] : [abs];
    if (parents) {
      let current = abs;
      while (current !== '/') {
        chain.unshift(current);
        current = dirnameOf(current);
      }
    }
    for (const dir of chain) {
      const walked = this._walk(dir, ident, true);
      if (walked.error) return { error: walked.error, path: dir, created };
      if (walked.node) {
        if (parents && walked.node.type === 'dir') continue;
        return {
          error: walked.node.type === 'dir' || !parents ? 'EEXIST' : 'ENOTDIR',
          path: dir,
          created,
        };
      }
      const parent = walked.parentNode;
      if (!parent) return { error: 'ENOENT', path: dir, created };
      if (parent.type !== 'dir') return { error: 'ENOTDIR', path: dir, created };
      if (!this._can(parent, ident, 3)) return { error: 'EACCES', path: dir, created };
      this.nodes.set(walked.path, {
        type: 'dir',
        mode: (mode ?? 0o777) & ~this.session.umask,
        uid: ident.uid,
        gid: parent.mode & 0o2000 ? parent.gid : ident.gid,
        mtime: this.now(),
        context: this._newContext(walked.path, parent, ident),
        ...(parent.mode & 0o2000 ? {} : {}),
      });
      if (parent.mode & 0o2000) this.nodes.get(walked.path).mode |= 0o2000;
      created.push(walked.path);
    }
    return { ok: true, created };
  }

  /** Can `ident` remove/rename entry `node` inside directory `parent` (w+x, sticky bit)? */
  _canUnlink(parent, node, ident) {
    if (!this._can(parent, ident, 3)) return false;
    if (parent.mode & 0o1000 && ident.uid !== 0) {
      return node.uid === ident.uid || parent.uid === ident.uid;
    }
    return true;
  }

  /** rmdir(2). */
  rmdir(input, { user, cwd } = {}) {
    this.sync();
    const abs = this.resolvePath(input, { cwd });
    const ident = this._ident(user);
    const walked = this._walk(abs, ident, false);
    if (walked.error) return { error: walked.error, path: abs };
    if (!walked.node) return { error: 'ENOENT', path: abs };
    if (walked.node.type !== 'dir') return { error: 'ENOTDIR', path: abs };
    if (this._childNames(walked.path).length) return { error: 'ENOTEMPTY', path: abs };
    if (!this._canUnlink(walked.parentNode, walked.node, ident))
      return { error: 'EACCES', path: abs };
    if (walked.path === HOME || walked.path === '/tmp' || walked.path === '/')
      return { error: 'EBUSY', path: abs };
    this._deleteNode(walked.path, walked.node);
    return { ok: true, path: walked.path };
  }

  /** unlink(2) (files, symlinks). */
  unlink(input, { user, cwd } = {}) {
    this.sync();
    const abs = this.resolvePath(input, { cwd });
    const ident = this._ident(user);
    const walked = this._walk(abs, ident, false);
    if (walked.error) return { error: walked.error, path: abs };
    if (!walked.node) return { error: 'ENOENT', path: abs };
    if (walked.node.type === 'dir') return { error: 'EISDIR', path: abs };
    if (!this._canUnlink(walked.parentNode, walked.node, ident))
      return { error: 'EACCES', path: abs };
    this._deleteNode(walked.path, walked.node);
    return { ok: true, path: walked.path };
  }

  /**
   * `rm -r` of one operand. Returns `{ok, removed: string[], errors: [{path, error}]}`;
   * like GNU rm it removes what it can and reports the rest.
   */
  removeTree(input, { user, cwd } = {}) {
    this.sync();
    const abs = this.resolvePath(input, { cwd });
    const ident = this._ident(user);
    const walked = this._walk(abs, ident, false);
    if (walked.error) return { errors: [{ path: abs, error: walked.error }], removed: [] };
    if (!walked.node) return { errors: [{ path: abs, error: 'ENOENT' }], removed: [] };
    const removed = [];
    const errors = [];
    const visit = (path, node, parentNode) => {
      if (node.type === 'dir') {
        if (!this._can(node, ident, 7)) {
          if (!this._can(node, ident, 4)) {
            errors.push({ path, error: 'EACCES', op: 'opendir' });
            return false;
          }
        }
        let ok = true;
        for (const name of this._childNames(path)) {
          const childPath = `${path === '/' ? '' : path}/${name}`;
          const child = this._lookup(childPath);
          if (!child) continue;
          if (!this._canUnlink(node, child, ident)) {
            errors.push({ path: childPath, error: 'EACCES' });
            ok = false;
            continue;
          }
          if (!visit(childPath, child, node)) ok = false;
        }
        if (!ok) return false;
        if (path === HOME || path === '/tmp' || path === '/') {
          errors.push({ path, error: 'EBUSY' });
          return false;
        }
        if (parentNode && !this._canUnlink(parentNode, node, ident)) {
          errors.push({ path, error: 'EACCES' });
          return false;
        }
        this._deleteNode(path, this._lookup(path) || node);
        removed.push(path);
        return true;
      }
      this._deleteNode(path, node);
      removed.push(path);
      return true;
    };
    if (!this._canUnlink(walked.parentNode, walked.node, ident) && walked.node.type !== 'dir') {
      return { errors: [{ path: abs, error: 'EACCES' }], removed };
    }
    visit(walked.path, walked.node, walked.parentNode);
    return { ok: errors.length === 0, removed, errors };
  }

  /** rename(2): `{ok}` or `{error, path}` (mv keeps owner, mode and SELinux label). */
  rename(source, destination, { user, cwd } = {}) {
    this.sync();
    const ident = this._ident(user);
    const from = this._walk(this.resolvePath(source, { cwd }), ident, false);
    if (from.error) return { error: from.error, path: source, side: 'source' };
    if (!from.node) return { error: 'ENOENT', path: source, side: 'source' };
    let destAbs = this.resolvePath(destination, { cwd });
    let to = this._walk(destAbs, ident, true);
    if (to.error) return { error: to.error, path: destination, side: 'dest' };
    if (to.node && to.node.type === 'dir') {
      destAbs = `${to.path === '/' ? '' : to.path}/${basenameOf(from.path)}`;
      to = this._walk(destAbs, ident, false);
      if (to.error) return { error: to.error, path: destAbs, side: 'dest' };
    }
    if (to.path === from.path) return { ok: true, path: to.path, same: true };
    if (from.node.type === 'dir' && isUnder(to.path, from.path))
      return { error: 'EINVAL', path: destination, side: 'dest' };
    if (!this._canUnlink(from.parentNode, from.node, ident))
      return { error: 'EACCES', path: source, side: 'move' };
    const destParent = to.parentNode;
    if (!destParent) return { error: 'ENOENT', path: destination, side: 'dest' };
    if (!this._can(destParent, ident, 3))
      return { error: 'EACCES', path: destination, side: 'move' };
    if (to.node) {
      if (to.node.type === 'dir' && from.node.type !== 'dir')
        return { error: 'EISDIR', path: destination, side: 'dest' };
      if (to.node.type === 'dir' && this._childNames(to.path).length)
        return { error: 'ENOTEMPTY', path: destination, side: 'dest' };
      this._deleteNode(to.path, to.node);
    }
    this._moveTree(from.path, from.node, to.path);
    return { ok: true, path: to.path };
  }

  _moveTree(fromPath, node, toPath) {
    const entries = [];
    const collect = (path, current) => {
      entries.push([path, current]);
      if (current.type === 'dir') {
        for (const name of this._childNames(path)) {
          const childPath = `${path === '/' ? '' : path}/${name}`;
          const child = this._lookup(childPath);
          if (child) collect(childPath, child);
        }
      }
    };
    collect(fromPath, node);
    const contents = entries.map(([path, current]) => [
      path,
      current,
      current.type === 'file' ? this._content(path, current) : null,
    ]);
    for (const [path, current] of [...contents].reverse()) this._deleteNode(path, current);
    for (const [path, current, content] of contents) {
      const target = toPath + path.slice(fromPath.length);
      const meta = { ...current };
      delete meta.key;
      delete meta.size;
      delete meta.vfs;
      delete meta.implicit;
      delete meta.content;
      if (current.type === 'file' && !current.generator && !current.binary) {
        this._createFile(target, content, {
          uid: meta.uid,
          gid: meta.gid,
          mode: meta.mode,
          context: meta.context,
          mtime: meta.mtime,
          hostOnly: Boolean(meta.hostOnly) && !isVfsArea(target),
        });
      } else {
        if (current.type === 'file') meta.content = content;
        this._ensureParents(target);
        this.nodes.set(target, meta);
      }
    }
  }

  /**
   * Copy one file or (recursive) tree. New files get the caller as owner and the target
   * directory's SELinux type unless `preserve` (cp -a / -p).
   */
  copy(source, destination, { user, cwd, recursive = false, preserve = false } = {}) {
    this.sync();
    const ident = this._ident(user);
    const from = this._walk(this.resolvePath(source, { cwd }), ident, true);
    if (from.error) return { error: from.error, path: source, side: 'source' };
    if (!from.node) return { error: 'ENOENT', path: source, side: 'source' };
    if (from.node.type === 'dir' && !recursive)
      return { error: 'OMIT_DIR', path: source, side: 'source' };
    let destAbs = this.resolvePath(destination, { cwd });
    let to = this._walk(destAbs, ident, true);
    if (to.error) return { error: to.error, path: destination, side: 'dest' };
    if (to.node && to.node.type === 'dir') {
      destAbs = `${to.path === '/' ? '' : to.path}/${basenameOf(from.path)}`;
      to = this._walk(destAbs, ident, true);
      if (to.error) return { error: to.error, path: destAbs, side: 'dest' };
    }
    if (to.path === from.path) return { error: 'SAME', path: destination, side: 'dest' };
    if (from.node.type === 'dir' && isUnder(to.path, from.path))
      return { error: 'INTO_SELF', path: destination, side: 'dest' };
    const errors = [];
    const copyOne = (srcPath, node, dstPath) => {
      const dst = this._walk(dstPath, ident, true);
      if (dst.error) {
        errors.push({ path: dstPath, error: dst.error, side: 'dest' });
        return;
      }
      if (node.type === 'dir') {
        if (!this._can(node, ident, 5)) {
          errors.push({ path: srcPath, error: 'EACCES', side: 'source' });
          return;
        }
        if (!dst.node) {
          if (!dst.parentNode || !this._can(dst.parentNode, ident, 3)) {
            errors.push({ path: dstPath, error: 'EACCES', side: 'mkdir' });
            return;
          }
          this.nodes.set(dst.path, {
            type: 'dir',
            mode: preserve ? node.mode : node.mode & ~this.session.umask,
            uid: preserve && ident.uid === 0 ? node.uid : ident.uid,
            gid: preserve && ident.uid === 0 ? node.gid : ident.gid,
            mtime: preserve ? node.mtime : this.now(),
            context: preserve ? node.context : this._newContext(dst.path, dst.parentNode, ident),
          });
        } else if (dst.node.type !== 'dir') {
          errors.push({ path: dstPath, error: 'ENOTDIR', side: 'dest' });
          return;
        }
        for (const name of this._childNames(srcPath)) {
          const childPath = `${srcPath === '/' ? '' : srcPath}/${name}`;
          const child = this._lookup(childPath);
          if (child) copyOne(childPath, child, `${dst.path === '/' ? '' : dst.path}/${name}`);
        }
        return;
      }
      if (!this._can(node, ident, 4)) {
        errors.push({ path: srcPath, error: 'EACCES', side: 'source' });
        return;
      }
      const content = this._content(srcPath, node);
      if (dst.node) {
        if (dst.node.type === 'dir') {
          errors.push({ path: dstPath, error: 'EISDIR', side: 'dest' });
          return;
        }
        if (!this._can(dst.node, ident, 2)) {
          errors.push({ path: dstPath, error: 'EACCES', side: 'create' });
          return;
        }
        this._setContent(dst.path, dst.node, content);
        return;
      }
      if (!dst.parentNode || !this._can(dst.parentNode, ident, 3)) {
        errors.push({ path: dstPath, error: dst.parentNode ? 'EACCES' : 'ENOENT', side: 'create' });
        return;
      }
      this._createFile(dst.path, content, {
        uid: preserve && ident.uid === 0 ? node.uid : ident.uid,
        gid: preserve && ident.uid === 0 ? node.gid : ident.gid,
        mode: preserve ? node.mode : node.mode & 0o777 & ~this.session.umask,
        context: preserve ? node.context : this._newContext(dst.path, dst.parentNode, ident),
        mtime: preserve ? node.mtime : undefined,
      });
      if (node.binary) {
        const created = this.nodes.get(dst.path);
        if (created && !created.vfs) {
          created.binary = true;
          created.size = node.size;
        }
      }
    };
    copyOne(from.path, from.node, to.path);
    if (errors.length)
      return { error: errors[0].error, path: errors[0].path, side: errors[0].side, errors };
    return { ok: true, path: to.path };
  }

  /** chmod(2): owner or root only. `modeSpec` is an octal/symbolic operand. */
  chmod(input, modeSpec, { user, cwd } = {}) {
    this.sync();
    const abs = this.resolvePath(input, { cwd });
    const ident = this._ident(user);
    const walked = this._walk(abs, ident, true);
    if (walked.error) return { error: walked.error, path: abs };
    if (!walked.node) return { error: 'ENOENT', path: abs };
    const next = applyChmod(modeSpec, walked.node.mode, {
      isDir: walked.node.type === 'dir',
      umask: this.session.umask,
    });
    if (next === null) return { error: 'EINVAL_MODE', path: abs };
    if (ident.uid !== 0 && walked.node.uid !== ident.uid) return { error: 'EPERM', path: abs };
    const before = walked.node.mode & 0o7777;
    let mode = next;
    // Non-root may not set setgid on a file whose group they are not a member of.
    if (ident.uid !== 0 && walked.node.type !== 'dir' && !ident.gids.has(walked.node.gid))
      mode &= ~0o2000;
    const meta = this._metaNode(walked.path, walked.node);
    meta.mode = mode;
    return { ok: true, path: walked.path, before, after: mode, node: meta };
  }

  /**
   * chown(2)/lchown: only root changes the owner; the owner may change the group to one of
   * their own groups. `{owner, group}` are names (or numeric strings).
   */
  chown(input, { owner, group } = {}, { user, cwd, follow = true } = {}) {
    this.sync();
    const abs = this.resolvePath(input, { cwd });
    const ident = this._ident(user);
    const walked = this._walk(abs, ident, follow);
    if (walked.error) return { error: walked.error, path: abs };
    if (!walked.node) return { error: 'ENOENT', path: abs };
    const node = walked.node;
    const uid =
      owner !== undefined && owner !== null && owner !== '' ? this._uidOf(owner) : node.uid;
    const gid =
      group !== undefined && group !== null && group !== '' ? this._gidOf(group) : node.gid;
    if (ident.uid !== 0) {
      if (uid !== node.uid) return { error: 'EPERM', path: abs };
      if (node.uid !== ident.uid) return { error: 'EPERM', path: abs };
      if (gid !== node.gid && !ident.gids.has(gid)) return { error: 'EPERM', path: abs };
    }
    const meta = this._metaNode(walked.path, node);
    const before = { uid: meta.uid, gid: meta.gid };
    meta.uid = uid;
    meta.gid = gid;
    // chown clears setuid/setgid on regular files (non-root caller, like the kernel).
    if (node.type === 'file' && ident.uid !== 0) meta.mode &= ~0o6000;
    return { ok: true, path: walked.path, before, after: { uid, gid }, node: meta };
  }

  /** symlink(2): `ln -s target linkpath`. */
  symlink(target, input, { user, cwd } = {}) {
    this.sync();
    const abs = this.resolvePath(input, { cwd });
    const ident = this._ident(user);
    const walked = this._walk(abs, ident, false);
    if (walked.error) return { error: walked.error, path: abs };
    if (walked.node) return { error: 'EEXIST', path: abs };
    if (!walked.parentNode || !this._can(walked.parentNode, ident, 3))
      return { error: walked.parentNode ? 'EACCES' : 'ENOENT', path: abs };
    this.nodes.set(walked.path, {
      type: 'link',
      target: String(target),
      mode: 0o777,
      uid: ident.uid,
      gid: ident.gid,
      mtime: this.now(),
      context: this._newContext(walked.path, walked.parentNode, ident),
    });
    return { ok: true, path: walked.path };
  }

  /** touch: create empty or bump mtime (owner/root or anyone with write access). */
  touch(input, { user, cwd } = {}) {
    this.sync();
    const abs = this.resolvePath(input, { cwd });
    const ident = this._ident(user);
    const walked = this._walk(abs, ident, true);
    if (walked.error) return { error: walked.error, path: abs };
    if (walked.node) {
      if (ident.uid !== 0 && walked.node.uid !== ident.uid && !this._can(walked.node, ident, 2)) {
        return { error: 'EACCES', path: abs };
      }
      const meta = this._metaNode(walked.path, walked.node);
      meta.mtime = this.now();
      return { ok: true, path: walked.path, created: false };
    }
    return this.writeFile(input, '', { user, cwd });
  }

  /** List a directory: `{ok, path, entries: [{name, path, node}]}` sorted like ls. */
  readdir(input, { user, cwd } = {}) {
    this.sync();
    const abs = this.resolvePath(input, { cwd });
    const ident = this._ident(user);
    const walked = this._walk(abs, ident, true);
    if (walked.error) return { error: walked.error, path: abs };
    if (!walked.node) return { error: 'ENOENT', path: abs };
    if (walked.node.type !== 'dir') return { error: 'ENOTDIR', path: abs, node: walked.node };
    if (!this._can(walked.node, ident, 4)) return { error: 'EACCES', path: abs };
    const entries = this._childNames(walked.path)
      .map((name) => {
        const path = `${walked.path === '/' ? '' : walked.path}/${name}`;
        return { name, path, node: this._lookup(path) };
      })
      .filter((entry) => entry.node)
      .sort((left, right) => collateNames(left.name, right.name));
    return { ok: true, path: walked.path, node: walked.node, entries };
  }

  /** Change the shell's working directory (`cd`): `{ok, path}` or `{error, path}`. */
  chdir(input, { user } = {}) {
    this.sync();
    const abs = this.resolvePath(input);
    const ident = this._ident(user);
    const walked = this._walk(abs, ident, true);
    if (walked.error) return { error: walked.error, path: abs };
    if (!walked.node) return { error: 'ENOENT', path: abs };
    if (walked.node.type !== 'dir') return { error: 'ENOTDIR', path: abs };
    if (!this._can(walked.node, ident, 1)) return { error: 'EACCES', path: abs };
    this.session.oldpwd = this.session.cwd;
    // bash keeps the logical path (cd -L): `cd /bin` shows /bin, not /usr/bin.
    this.session.cwd = abs === `${HOME}/tmp` || abs.startsWith(`${HOME}/tmp/`) ? walked.path : abs;
    return { ok: true, path: this.session.cwd };
  }

  /** Executable lookup on a PATH string (for scripts on ~/bin etc.). */
  findOnPath(name, pathValue, { user } = {}) {
    const dirs = String(pathValue || '')
      .split(':')
      .filter(Boolean);
    for (const dir of dirs) {
      const candidate = normalizePath(`${dir}/${name}`);
      const found = this.stat(candidate, { user });
      if (found.ok && found.node.type === 'file') return { path: candidate, node: found.node };
    }
    return null;
  }

  // ── default filesystem ───────────────────────────────────────────────────

  _buildTree() {
    const dirs = [
      ['/', 0o555],
      ['/afs', 0o555],
      ['/boot', 0o555],
      ['/boot/efi', 0o700],
      ['/dev', 0o755],
      ['/dev/pts', 0o755],
      ['/dev/shm', 0o1777],
      ['/etc', 0o755],
      ['/home', 0o755],
      ['/media', 0o755],
      ['/mnt', 0o755],
      ['/opt', 0o755],
      ['/proc', 0o555],
      ['/root', 0o550],
      ['/run', 0o755],
      ['/run/lock', 0o755],
      ['/srv', 0o755],
      ['/sys', 0o555],
      ['/tmp', 0o1777],
      ['/usr', 0o755],
      ['/usr/bin', 0o755],
      ['/usr/sbin', 0o755],
      ['/usr/lib', 0o555],
      ['/usr/lib64', 0o555],
      ['/usr/libexec', 0o755],
      ['/usr/include', 0o755],
      ['/usr/games', 0o755],
      ['/usr/src', 0o755],
      ['/usr/share', 0o755],
      ['/usr/share/doc', 0o755],
      ['/usr/share/man', 0o755],
      ['/usr/local', 0o755],
      ['/usr/local/bin', 0o755],
      ['/usr/local/etc', 0o755],
      ['/usr/local/games', 0o755],
      ['/usr/local/include', 0o755],
      ['/usr/local/lib', 0o755],
      ['/usr/local/lib64', 0o755],
      ['/usr/local/libexec', 0o755],
      ['/usr/local/sbin', 0o755],
      ['/usr/local/share', 0o755],
      ['/usr/local/src', 0o755],
      ['/usr/lib/systemd', 0o755],
      ['/usr/lib/systemd/system', 0o755],
      ['/usr/lib/firewalld', 0o755],
      ['/usr/lib/firewalld/zones', 0o755],
      ['/usr/lib/firewalld/services', 0o755],
      ['/var', 0o755],
      ['/var/adm', 0o755],
      ['/var/cache', 0o755],
      ['/var/crash', 0o755],
      ['/var/db', 0o755],
      ['/var/empty', 0o755],
      ['/var/games', 0o755],
      ['/var/lib', 0o755],
      ['/var/local', 0o755],
      ['/var/log', 0o755],
      ['/var/log/audit', 0o700],
      ['/var/opt', 0o755],
      ['/var/spool', 0o755],
      ['/var/spool/cron', 0o700],
      ['/var/tmp', 0o1777],
      ['/etc/sysconfig', 0o755],
      ['/etc/profile.d', 0o755],
      ['/etc/skel', 0o755],
      ['/etc/ssh', 0o755],
      ['/etc/ssh/sshd_config.d', 0o755],
      ['/etc/sudoers.d', 0o750],
      ['/etc/selinux', 0o755],
      ['/etc/systemd', 0o755],
      ['/etc/systemd/system', 0o755],
      ['/etc/systemd/system/multi-user.target.wants', 0o755],
      ['/etc/firewalld', 0o750],
      ['/etc/firewalld/zones', 0o750],
      ['/etc/firewalld/services', 0o750],
      ['/etc/yum.repos.d', 0o755],
      ['/etc/dnf', 0o755],
      ['/etc/containers', 0o755],
      ['/etc/NetworkManager', 0o755],
      ['/etc/NetworkManager/system-connections', 0o700],
      ['/etc/pki', 0o755],
      ['/etc/cron.d', 0o755],
      ['/etc/cron.daily', 0o755],
    ];
    for (const [path, mode] of dirs) this._mk(path, { type: 'dir', mode });
    this.nodes.get('/var/spool').mode = 0o755;
    this._mk('/var/spool/mail', { type: 'dir', mode: 0o775, group: 'mail' });
    this._mk('/var/lib/chrony', { type: 'dir', mode: 0o750, owner: 'chrony', group: 'chrony' });
    this._mk('/var/log/chrony', { type: 'dir', mode: 0o750, owner: 'chrony', group: 'chrony' });
    this._mk('/home/student', { type: 'dir', mode: 0o700, owner: 'student', group: 'student' });
    this._mk('/run/user/1000', { type: 'dir', mode: 0o700, owner: 'student', group: 'student' });
    for (const [path, target] of [
      ['/bin', 'usr/bin'],
      ['/sbin', 'usr/sbin'],
      ['/lib', 'usr/lib'],
      ['/lib64', 'usr/lib64'],
      ['/var/run', '../run'],
      ['/var/lock', '../run/lock'],
      ['/var/mail', 'spool/mail'],
      ['/etc/os-release', '../usr/lib/os-release'],
      ['/etc/system-release', 'redhat-release'],
      ['/etc/localtime', '../usr/share/zoneinfo/UTC'],
      ['/usr/bin/sh', 'bash'],
      ['/usr/bin/dnf', 'dnf-3'],
      ['/usr/bin/yum', 'dnf-3'],
    ]) {
      this._mk(path, { target });
    }
    // devices
    for (const [name, rdev, mode, group] of [
      ['null', [1, 3], 0o666, 'root'],
      ['zero', [1, 5], 0o666, 'root'],
      ['random', [1, 8], 0o666, 'root'],
      ['urandom', [1, 9], 0o666, 'root'],
      ['tty', [5, 0], 0o666, 'tty'],
      ['console', [5, 1], 0o600, 'root'],
    ]) {
      this._mk(`/dev/${name}`, { type: 'char', rdev, mode, group, mtime: this.bootTime });
    }
    for (const [name, minor] of [
      ['vda', 0],
      ['vda1', 1],
      ['vda2', 2],
      ['vda3', 3],
      ['vda4', 4],
    ]) {
      this._mk(`/dev/${name}`, {
        type: 'block',
        rdev: [252, minor],
        mode: 0o660,
        group: 'disk',
        mtime: this.bootTime,
      });
    }
    // /etc
    const etcFiles = [
      ['/usr/lib/os-release', OS_RELEASE],
      ['/etc/redhat-release', `Red Hat Enterprise Linux release ${RHEL_VERSION} (Plow)\n`],
      ['/etc/hostname', { generator: 'hostname' }],
      ['/etc/hosts', ETC_HOSTS],
      ['/etc/resolv.conf', ETC_RESOLV],
      ['/etc/nsswitch.conf', ETC_NSSWITCH],
      ['/etc/passwd', { generator: 'passwd' }],
      ['/etc/group', { generator: 'group' }],
      ['/etc/shadow', { generator: 'shadow', mode: 0o000 }],
      ['/etc/gshadow', { generator: 'gshadow', mode: 0o000 }],
      ['/etc/selinux/config', SELINUX_CONFIG('enforcing')],
      ['/etc/fstab', ETC_FSTAB],
      ['/etc/sudoers', { content: ETC_SUDOERS, mode: 0o440 }],
      ['/etc/sudoers.d/student', { content: 'student ALL=(ALL) NOPASSWD: ALL\n', mode: 0o440 }],
      ['/etc/ssh/sshd_config', { content: ETC_SSHD_CONFIG, mode: 0o600 }],
      [
        '/etc/ssh/sshd_config.d/50-redhat.conf',
        {
          content:
            '# This system is following system-wide crypto policy. The changes to\n# crypto properties (Ciphers, MACs, ...) will not have any effect in\n# this or following included files. To override some configuration option,\n# write it before this block or in other include file *before* this file.\nInclude /etc/crypto-policies/back-ends/opensshserver.config\n\nSyslogFacility AUTHPRIV\n\nChallengeResponseAuthentication no\n\nGSSAPIAuthentication yes\nGSSAPICleanupCredentials no\n\nUsePAM yes\n\nX11Forwarding yes\n\nPrintMotd no\n',
          mode: 0o600,
        },
      ],
      ['/etc/chrony.conf', ETC_CHRONY],
      ['/etc/crontab', ETC_CRONTAB],
      ['/etc/login.defs', ETC_LOGIN_DEFS],
      ['/etc/motd', ''],
      ['/etc/issue', '\\S\nKernel \\r on an \\m\n\n'],
      ['/etc/shells', '/bin/sh\n/bin/bash\n/usr/bin/sh\n/usr/bin/bash\n'],
      ['/etc/environment', ''],
      ['/etc/machine-id', { content: '2d0a8c1f7e9b4b5c9a3f6e1d2c4b8a07\n', mode: 0o444 }],
      ['/etc/bashrc', ETC_BASHRC],
      [
        '/etc/profile',
        "# /etc/profile\n\n# System wide environment and startup programs, for login setup\n# Functions and aliases go in /etc/bashrc\n\n# It's NOT a good idea to change this file unless you know what you\n# are doing. It's much better to create a custom.sh shell script in\n# /etc/profile.d/ to make custom changes to your environment, as this\n# will prevent the need for merging in future updates.\n",
      ],
      ['/etc/skel/.bashrc', SKEL_BASHRC],
      ['/etc/skel/.bash_profile', SKEL_BASH_PROFILE],
      ['/etc/skel/.bash_logout', SKEL_BASH_LOGOUT],
      ['/etc/yum.repos.d/redhat.repo', REDHAT_REPO(Object.values(REPOS))],
      [
        '/etc/dnf/dnf.conf',
        '[main]\ngpgcheck=1\ninstallonly_limit=3\nclean_requirements_on_remove=True\nbest=True\nskip_if_unavailable=False\n',
      ],
      ['/etc/containers/registries.conf', ETC_REGISTRIES],
      ['/etc/firewalld/firewalld.conf', ETC_FIREWALLD_CONF],
      [
        '/usr/lib/firewalld/zones/public.xml',
        this._zoneXml('public', DEFAULT_FIREWALL_SERVICES, []),
      ],
      [
        '/etc/NetworkManager/system-connections/eth0.nmconnection',
        {
          content: `[connection]\nid=eth0\nuuid=9c92fad9-6ecb-3e6c-eb4d-8a47c6f50c04\ntype=ethernet\ninterface-name=eth0\n\n[ethernet]\n\n[ipv4]\naddress1=${WORKSTATION_IP}/24,${GATEWAY_IP}\ndns=${DNS_SERVER_IP};\ndns-search=lab.example.com;\nmethod=manual\n\n[ipv6]\naddr-gen-mode=eui64\nmethod=auto\n\n[proxy]\n`,
          mode: 0o600,
        },
      ],
      ['/usr/share/zoneinfo/UTC', { binary: true, size: 114, mode: 0o644 }],
      ['/root/.bash_profile', SKEL_BASH_PROFILE],
      [
        '/root/.bashrc',
        "# .bashrc\n\n# User specific aliases and functions\n\nalias rm='rm -i'\nalias cp='cp -i'\nalias mv='mv -i'\n\n# Source global definitions\nif [ -f /etc/bashrc ]; then\n\t. /etc/bashrc\nfi\n",
      ],
      ['/root/.bash_logout', SKEL_BASH_LOGOUT],
      [
        '/root/anaconda-ks.cfg',
        {
          content:
            "# Generated by Anaconda 34.25.5.9\n# Generated by pykickstart v3.32\n#version=RHEL9\n# Use graphical install\ngraphical\n\n# Keyboard layouts\nkeyboard --vckeymap=us --xlayouts='us'\n# System language\nlang en_US.UTF-8\n\n%packages\n@^minimal-environment\n\n%end\n\n# Run the Setup Agent on first boot\nfirstboot --enable\n\n# System timezone\ntimezone Etc/UTC --utc\n\n# Root password\nrootpw --iscrypted --allow-ssh $6$rRVsDuo3nQb4JqZg$Fv1bVXl2lN4qXvVQ0wJ1mJk3pB2yH6xS0rN2bE3cE5n1cW9yQ8sP4bL7mD2xQ1rW6uE3oT5aK9zV0hG8jC4nF/\n",
          mode: 0o600,
        },
      ],
      ['/var/log/messages', { generator: 'messages', mode: 0o600 }],
      ['/var/log/secure', { generator: 'secure', mode: 0o600 }],
      ['/var/log/cron', { generator: 'cron', mode: 0o600 }],
      ['/var/log/maillog', { content: '', mode: 0o600 }],
      ['/var/log/boot.log', { generator: 'boot-log', mode: 0o600 }],
      ['/var/log/dnf.log', { generator: 'dnf-log', mode: 0o644 }],
      ['/var/log/dnf.rpm.log', { generator: 'dnf-rpm-log', mode: 0o644 }],
      ['/var/log/audit/audit.log', { generator: 'audit', mode: 0o600 }],
      ['/var/log/wtmp', { binary: true, size: 61824, mode: 0o664, group: 'utmp' }],
      ['/var/log/btmp', { binary: true, size: 0, mode: 0o660, group: 'utmp' }],
      ['/var/log/lastlog', { binary: true, size: 292292, mode: 0o664, group: 'utmp' }],
      ['/proc/cpuinfo', { generator: 'cpuinfo', mode: 0o444 }],
      ['/proc/meminfo', { generator: 'meminfo', mode: 0o444 }],
      ['/proc/loadavg', { generator: 'loadavg', mode: 0o444 }],
      ['/proc/uptime', { generator: 'uptime', mode: 0o444 }],
      ['/proc/version', { generator: 'version', mode: 0o444 }],
      ['/proc/mounts', { generator: 'mounts', mode: 0o444 }],
      [
        '/proc/cmdline',
        {
          content: `BOOT_IMAGE=(hd0,gpt3)/vmlinuz-${KERNEL_RELEASE} root=UUID=4f2a1c7e-1b9d-4c55-9a51-6d1f0e3b2a77 console=tty0 console=ttyS0,115200n8 no_timer_check net.ifnames=0 crashkernel=1G-4G:192M,4G-64G:256M,64G-:512M\n`,
          mode: 0o444,
        },
      ],
    ];
    for (const [path, spec] of etcFiles) {
      const options = typeof spec === 'string' ? { content: spec } : { ...spec };
      if (path.startsWith('/proc/')) options.mtime = this.now();
      this._mk(path, options);
    }
    // The student's home: the skel dotfiles are host-only (they never clutter the Files panel).
    for (const [file, content] of [
      ['.bash_logout', SKEL_BASH_LOGOUT],
      ['.bash_profile', SKEL_BASH_PROFILE],
      ['.bashrc', SKEL_BASHRC],
    ]) {
      this._mk(`${HOME}/${file}`, {
        content,
        owner: 'student',
        group: 'student',
        hostOnly: true,
        mtime: this.installTime,
      });
    }
    // Installed packages lay down their binaries (+ files/units/users) silently.
    for (const [name, pkg] of this.catalog) {
      if (pkg.defaultInstalled) this._installPackageFiles(name, { boot: true });
    }
  }

  _zoneXml(zone, services, ports) {
    const lines = ['<?xml version="1.0" encoding="utf-8"?>', '<zone>'];
    lines.push('  <short>Public</short>');
    lines.push(
      '  <description>For use in public areas. You do not trust the other computers on networks to not harm your computer. Only selected incoming connections are accepted.</description>'
    );
    for (const service of services) lines.push(`  <service name="${service}"/>`);
    for (const port of ports) {
      const [number, protocol] = String(port).split('/');
      lines.push(`  <port port="${number}" protocol="${protocol}"/>`);
    }
    lines.push('  <forward/>', '</zone>', '');
    return lines.join('\n');
  }

  // ── packages ─────────────────────────────────────────────────────────────

  _buildCatalog() {
    for (const [
      name,
      evr,
      arch,
      repoKey,
      downloadKiB,
      installKiB,
      summary,
      extra = {},
    ] of PACKAGE_DEFS) {
      if (extra.hidden) continue;
      this._addCatalogPackage({
        name,
        evr,
        arch,
        repo: repoKey,
        downloadKiB,
        installKiB,
        summary,
        ...extra,
      });
    }
    for (const [name, pkg] of this.catalog) {
      if (pkg.defaultInstalled) {
        this.installed.set(name, { time: this.installTime, repo: 'anaconda', reason: 'user' });
      }
    }
  }

  _addCatalogPackage(spec) {
    const evr = parseEvr(spec.evr || `${spec.version || '1.0'}-${spec.release || '1.el9'}`);
    const repoKey = REPOS[spec.repo]
      ? spec.repo
      : Object.keys(REPOS).find((key) => REPOS[key].id === spec.repo) || 'appstream';
    const pkg = {
      name: spec.name,
      epoch: evr.epoch,
      version: spec.version || evr.version,
      release: spec.release || evr.release,
      arch: spec.arch || 'x86_64',
      repo: repoKey,
      downloadKiB: Number(spec.downloadKiB ?? spec.size ?? 120),
      installKiB: Number(spec.installKiB ?? (spec.size ? spec.size * 3 : 360)),
      summary: spec.summary || spec.name,
      description: spec.description || spec.summary || spec.name,
      license: spec.license || 'GPLv2+',
      url: spec.url || `https://www.redhat.com/`,
      requires: [...(spec.requires || [])],
      bins: [...(spec.bins || [])],
      sbins: [...(spec.sbins || [])],
      files: spec.files ? { ...spec.files } : {},
      units: [...(spec.units || [])],
      users: (spec.users || []).map((entry) => [...entry]),
      defaultInstalled: Boolean(spec.installed),
    };
    this.catalog.set(pkg.name, pkg);
    return pkg;
  }

  /** `httpd-2.4.62-4.el9.x86_64` (rpm -q form, no epoch). */
  nevra(name) {
    const pkg = this.catalog.get(name);
    if (!pkg) return name;
    return `${pkg.name}-${pkg.version}-${pkg.release}.${pkg.arch}`;
  }

  /** `2.4.62-4.el9` or `2:1.34-7.el9`. */
  evr(name, { epoch = true } = {}) {
    const pkg = this.catalog.get(name);
    if (!pkg) return '';
    return `${epoch && pkg.epoch ? `${pkg.epoch}:` : ''}${pkg.version}-${pkg.release}`;
  }

  isInstalled(name) {
    return this.installed.has(String(name));
  }

  /** Package owning a command name (null when not packaged). */
  packageForCommand(command) {
    return COMMAND_PACKAGE.get(String(command)) || null;
  }

  /** True unless the command's package is known AND not installed. */
  commandAvailable(command) {
    const pkg = this.packageForCommand(command);
    return !pkg || this.isInstalled(pkg);
  }

  /** Packages (incl. missing dependencies) a `dnf install` of `names` would add, ordered. */
  resolveInstall(names) {
    const order = [];
    const seen = new Set();
    const visit = (name, reason) => {
      if (seen.has(name) || this.isInstalled(name)) return;
      const pkg = this.catalog.get(name);
      if (!pkg) return;
      seen.add(name);
      for (const dep of pkg.requires) visit(dep, 'dependency');
      order.push({ name, reason });
    };
    for (const name of names) visit(name, 'user');
    return order;
  }

  /** Install packages (no output; dnf formats it). Creates files, users, units. */
  installPackages(names, { reason = 'user' } = {}) {
    const plan = this.resolveInstall(names);
    for (const entry of plan) {
      const pkg = this.catalog.get(entry.name);
      this.installed.set(entry.name, {
        time: this.now(),
        repo: REPOS[pkg.repo].id,
        reason: entry.reason === 'user' ? reason : 'dependency',
      });
      this._installPackageFiles(entry.name);
      this._journalAppend({
        ident: 'dnf',
        pid: this._allocPid(),
        message: `Installed: ${this.nevra(entry.name)}`,
        priority: 6,
        internal: true,
      });
    }
    this.dnfHistory = this.dnfHistory || [];
    if (plan.length)
      this.dnfHistory.push({
        action: 'Install',
        names: plan.map((entry) => entry.name),
        time: this.now(),
      });
    return plan;
  }

  _installPackageFiles(name, { boot = false } = {}) {
    const pkg = this.catalog.get(name);
    if (!pkg) return;
    for (const [user, uid, gid, gecos, home, shell] of pkg.users) {
      if (!this.users.has(user)) {
        if (!this.groups.has(user)) this.groups.set(user, { name: user, gid, members: new Set() });
        this.users.set(user, { name: user, uid, gid, gecos, home, shell });
        this.shadow.set(user, { hash: '!!', lastChange: 20304, min: 0, max: 99999, warn: 7 });
      }
    }
    const mtime = boot ? this.installTime : this.now();
    for (const bin of pkg.bins) {
      if (!this.nodes.has(`/usr/bin/${bin}`)) {
        const special = {
          sudo: 0o4111,
          passwd: 0o4755,
          su: 0o4755,
          crontab: 0o4755,
          mount: 0o4755,
        }[bin];
        this._mk(`/usr/bin/${bin}`, { binary: true, mode: special ?? 0o755, mtime, pkg: name });
      }
    }
    for (const bin of pkg.sbins) {
      if (!this.nodes.has(`/usr/sbin/${bin}`))
        this._mk(`/usr/sbin/${bin}`, { binary: true, mode: 0o755, mtime });
    }
    for (const [path, spec] of Object.entries(pkg.files || {})) {
      if (this.nodes.has(path) && !(spec && typeof spec === 'object' && spec.generator)) continue;
      if (spec === null) this._mk(path, { type: 'dir', mtime });
      else if (typeof spec === 'string') this._mk(path, { content: spec, mtime });
      else this._mk(path, { ...spec, mtime });
    }
    for (const unitName of pkg.units) {
      const def = UNIT_DEFS[unitName];
      if (def) this._registerUnit(unitName, def, { mtime });
    }
  }

  /** Remove packages: files go, modified configs are kept as `.rpmsave`, units stop. */
  removePackages(names) {
    const removed = [];
    for (const name of names) {
      const pkg = this.catalog.get(name);
      if (!pkg || !this.isInstalled(name)) continue;
      for (const unitName of pkg.units) {
        const unit = this.units.get(`${unitName}.service`);
        if (unit) {
          if (unit.active === 'active') this._stopUnit(unit, { quiet: true });
          this._setEnabled(unit, false);
          this.units.delete(unit.name);
          this.nodes.delete(`/usr/lib/systemd/system/${unit.name}`);
        }
      }
      for (const bin of pkg.bins) this.nodes.delete(`/usr/bin/${bin}`);
      for (const bin of pkg.sbins) this.nodes.delete(`/usr/sbin/${bin}`);
      const files = Object.entries(pkg.files || {}).sort((a, b) => b[0].length - a[0].length);
      for (const [path, spec] of files) {
        const node = this.nodes.get(path);
        if (!node) continue;
        if (node.type === 'dir') {
          if (!this._childNames(path).length) this.nodes.delete(path);
          continue;
        }
        if (typeof spec === 'string' && node.content !== spec && /^\/etc\//.test(path)) {
          this.nodes.set(`${path}.rpmsave`, { ...node });
        }
        this.nodes.delete(path);
      }
      this.installed.delete(name);
      removed.push(name);
    }
    this.dnfHistory = this.dnfHistory || [];
    if (removed.length)
      this.dnfHistory.push({ action: 'Removed', names: removed, time: this.now() });
    return removed;
  }

  // ── generated files ──────────────────────────────────────────────────────

  _generate(kind, path) {
    switch (kind) {
      case 'passwd':
        return `${[...this.users.values()]
          .map((u) => `${u.name}:x:${u.uid}:${u.gid}:${u.gecos}:${u.home}:${u.shell}`)
          .join('\n')}\n`;
      case 'group':
        return `${[...this.groups.values()]
          .map((g) => `${g.name}:x:${g.gid}:${[...g.members].join(',')}`)
          .join('\n')}\n`;
      case 'shadow':
        return `${[...this.users.values()]
          .map((u) => {
            const s = this.shadow.get(u.name) || {
              hash: '!!',
              lastChange: 20304,
              min: 0,
              max: 99999,
              warn: 7,
            };
            return `${u.name}:${s.hash}:${s.lastChange}:${s.min}:${s.max}:${s.warn}:::`;
          })
          .join('\n')}\n`;
      case 'gshadow':
        return `${[...this.groups.values()]
          .map((g) => `${g.name}:!::${[...g.members].join(',')}`)
          .join('\n')}\n`;
      case 'hostname':
        return `${this.hostname}\n`;
      case 'messages':
        return this._syslogText(
          (entry) => entry.facility !== 'authpriv' && entry.facility !== 'cron'
        );
      case 'secure':
        return this._syslogText((entry) => entry.facility === 'authpriv');
      case 'cron':
        return this._syslogText((entry) => entry.facility === 'cron');
      case 'boot-log':
        return this.journal
          .filter(
            (entry) =>
              entry.ident === 'systemd' &&
              /^(Started|Finished|Reached target) /.test(entry.message) &&
              entry.time <= this.bootTime + 60000
          )
          .map((entry) => `[  OK  ] ${entry.message.replace(/\.$/, '')}.`)
          .join('\n')
          .concat('\n');
      case 'dnf-log':
      case 'dnf-rpm-log':
        return (this.dnfHistory || [])
          .flatMap((entry) =>
            entry.names.map(
              (name) =>
                `${new Date(entry.time).toISOString().replace(/\.\d+Z$/, '+0000')} SUBDEBUG ${entry.action}: ${this.nevra(name)}`
            )
          )
          .join('\n')
          .concat('\n');
      case 'audit':
        return this.selinux.denials
          .map(
            (denial) =>
              `type=AVC msg=audit(${(denial.time / 1000).toFixed(3)}:${denial.serial}): avc:  denied  { ${denial.perm} } for  pid=${denial.pid} comm="${denial.comm}" name="${denial.name}" dev="vda4" ino=${denial.ino} scontext=${denial.scontext} tcontext=${denial.tcontext} tclass=${denial.tclass} permissive=0`
          )
          .join('\n')
          .concat(this.selinux.denials.length ? '\n' : '');
      case 'httpd-error-log':
        return this._httpdErrorLog();
      case 'httpd-access-log':
        return this.httpLog
          .filter((entry) => entry.server === 'httpd')
          .map(
            (entry) =>
              `${entry.client} - - [${this._apacheTime(entry.time)}] "${entry.method} ${entry.path} HTTP/1.1" ${entry.status} ${entry.bytes} "-" "curl/7.76.1"`
          )
          .join('\n')
          .concat('\n');
      case 'cpuinfo':
        return Array.from({ length: CPU_COUNT }, (_, index) =>
          [
            `processor\t: ${index}`,
            'vendor_id\t: GenuineIntel',
            'cpu family\t: 6',
            'model\t\t: 85',
            'model name\t: Intel Xeon Processor (Cascadelake)',
            'stepping\t: 6',
            'cpu MHz\t\t: 2294.608',
            'cache size\t: 16384 KB',
            `physical id\t: ${index}`,
            'siblings\t: 1',
            'core id\t\t: 0',
            'cpu cores\t: 1',
            'fpu\t\t: yes',
            'flags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ss syscall nx pdpe1gb rdtscp lm constant_tsc rep_good nopl xtopology cpuid tsc_known_freq pni pclmulqdq vmx ssse3 fma cx16 pcid sse4_1 sse4_2 x2apic movbe popcnt aes xsave avx f16c rdrand hypervisor lahf_lm abm 3dnowprefetch avx2',
            'bogomips\t: 4589.21',
            'address sizes\t: 46 bits physical, 48 bits virtual',
            '',
          ].join('\n')
        ).join('\n');
      case 'meminfo': {
        const mem = this.memory();
        return [
          `MemTotal:        ${String(mem.total).padStart(8)} kB`,
          `MemFree:         ${String(mem.free).padStart(8)} kB`,
          `MemAvailable:    ${String(mem.available).padStart(8)} kB`,
          `Buffers:         ${String(5320).padStart(8)} kB`,
          `Cached:          ${String(mem.cache - 5320).padStart(8)} kB`,
          `SwapCached:      ${String(0).padStart(8)} kB`,
          `SwapTotal:       ${String(0).padStart(8)} kB`,
          `SwapFree:        ${String(0).padStart(8)} kB`,
          `Shmem:           ${String(mem.shared).padStart(8)} kB`,
          '',
        ].join('\n');
      }
      case 'loadavg': {
        const load = this.loadAverage();
        const procs = this.listProcesses();
        return `${load.map((value) => value.toFixed(2)).join(' ')} ${procs.filter((p) => p.state === 'R').length}/${procs.length} ${this.nextPid}\n`;
      }
      case 'uptime': {
        const seconds = (this.now() - this.bootTime) / 1000;
        return `${seconds.toFixed(2)} ${(seconds * CPU_COUNT * 0.97).toFixed(2)}\n`;
      }
      case 'version':
        return `Linux version ${KERNEL_RELEASE} (mockbuild@x86-64-03.build.eng.rdu2.redhat.com) (gcc (GCC) 11.5.0 20240719 (Red Hat 11.5.0-5), GNU ld version 2.35.2-63.el9) ${KERNEL_VERSION}\n`;
      case 'mounts':
        return [
          'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0',
          'sysfs /sys sysfs rw,seclabel,nosuid,nodev,noexec,relatime 0 0',
          'devtmpfs /dev devtmpfs rw,seclabel,nosuid,size=4096k,nr_inodes=458722,mode=755,inode64 0 0',
          'tmpfs /dev/shm tmpfs rw,seclabel,nosuid,nodev,inode64 0 0',
          'tmpfs /run tmpfs rw,seclabel,nosuid,nodev,size=742996k,nr_inodes=819200,mode=755,inode64 0 0',
          '/dev/vda4 / xfs rw,seclabel,relatime,attr2,inode64,logbufs=8,logbsize=32k,noquota 0 0',
          'selinuxfs /sys/fs/selinux selinuxfs rw,nosuid,noexec,relatime 0 0',
          '/dev/vda3 /boot xfs rw,seclabel,relatime,attr2,inode64,logbufs=8,logbsize=32k,noquota 0 0',
          '/dev/vda2 /boot/efi vfat rw,relatime,fmask=0077,dmask=0077,codepage=437,iocharset=ascii,shortname=winnt,errors=remount-ro 0 0',
          'tmpfs /run/user/1000 tmpfs rw,seclabel,nosuid,nodev,relatime,size=371496k,nr_inodes=92874,mode=700,uid=1000,gid=1000,inode64 0 0',
          '',
        ].join('\n');
      default:
        return '';
    }
  }

  /** Writes to generated files update the model (`/etc/passwd` edits, `/etc/hostname`). */
  _acceptGenerated(kind, path, content) {
    const lines = String(content)
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('#'));
    if (kind === 'hostname') {
      this.hostname = (lines[0] || HOSTNAME_FQDN).trim();
      return;
    }
    if (kind === 'passwd') {
      const next = new Map();
      for (const line of lines) {
        const [name, , uid, gid, gecos, home, shell] = line.split(':');
        if (!name) continue;
        next.set(name, {
          name,
          uid: Number(uid),
          gid: Number(gid),
          gecos: gecos ?? '',
          home: home ?? '',
          shell: shell ?? '',
        });
      }
      this.users = next;
      return;
    }
    if (kind === 'group') {
      const next = new Map();
      for (const line of lines) {
        const [name, , gid, members] = line.split(':');
        if (!name) continue;
        next.set(name, {
          name,
          gid: Number(gid),
          members: new Set(
            String(members || '')
              .split(',')
              .filter(Boolean)
          ),
        });
      }
      this.groups = next;
      return;
    }
    if (kind === 'shadow') {
      for (const line of lines) {
        const [name, hash, lastChange, min, max, warn] = line.split(':');
        if (!name) continue;
        this.shadow.set(name, {
          hash: hash ?? '!!',
          lastChange: Number(lastChange) || 0,
          min: Number(min) || 0,
          max: Number(max) || 99999,
          warn: Number(warn) || 7,
        });
      }
    }
  }

  _apacheTime(ms) {
    const parts = clockParts(ms);
    return `${pad2(parts.day)}/${MONTHS[parts.month]}/${parts.year}:${pad2(parts.hours)}:${pad2(parts.minutes)}:${pad2(parts.seconds)} +0000`;
  }

  _syslogText(filter) {
    const short = this.hostname.split('.')[0];
    const lines = this.journal
      .filter((entry) => !entry.kernelOnly && filter(entry))
      .map(
        (entry) =>
          `${formatSyslogTime(entry.time)} ${short} ${entry.ident}${entry.pid ? `[${entry.pid}]` : ''}: ${entry.message}`
      );
    return lines.length ? `${lines.join('\n')}\n` : '';
  }

  // ── systemd units ────────────────────────────────────────────────────────

  /** Canonical unit name: `httpd` → `httpd.service`. */
  unitName(name) {
    const text = String(name || '').trim();
    if (!text) return '';
    return /\.(service|socket|target|timer|mount|path|slice|scope)$/.test(text)
      ? text
      : `${text}.service`;
  }

  getUnit(name) {
    return this.units.get(this.unitName(name)) || null;
  }

  _renderUnitFile(def) {
    const lines = ['[Unit]', `Description=${def.description}`];
    if (def.docs?.length) lines.push(`Documentation=${def.docs.join(' ')}`);
    lines.push('After=network.target', '', '[Service]');
    lines.push(`Type=${def.type === 'idle' ? 'idle' : def.type || 'simple'}`);
    if (def.user && def.user !== 'root') lines.push(`User=${def.user}`);
    lines.push(`ExecStart=${def.exec || def.cmd}`);
    if (def.reload) lines.push(`ExecReload=${def.reload}`);
    if (def.restart && def.restart !== 'no') lines.push(`Restart=${def.restart}`);
    lines.push('', '[Install]', `WantedBy=${def.wantedBy || 'multi-user.target'}`, '');
    return lines.join('\n');
  }

  _registerUnit(short, def, { mtime, custom = false, path } = {}) {
    const name = this.unitName(short);
    const unitPath = path || `/usr/lib/systemd/system/${name}`;
    if (!path) {
      this._mk(unitPath, {
        content: def.unitFile || this._renderUnitFile(def),
        mtime: mtime ?? this.installTime,
      });
    }
    const existing = this.units.get(name);
    const unit = existing || {
      name,
      short: name.replace(/\.service$/, ''),
      active: 'inactive',
      sub: 'dead',
      enabled: def.preset === 'static' ? 'static' : 'disabled',
      since: null,
      mainPid: null,
      pids: [],
      result: 'success',
      exitStatus: 0,
      failWhen: [],
      cpuMs: 0,
    };
    unit.def = { ...def };
    unit.preset =
      def.preset === 'enabled' ? 'enabled' : def.preset === 'static' ? 'static' : 'disabled';
    unit.unitPath = unitPath;
    unit.custom = custom;
    this.units.set(name, unit);
    return unit;
  }

  _buildUnits() {
    for (const short of Object.keys(UNIT_DEFS)) {
      const def = UNIT_DEFS[short];
      if (def.pkg && !this.isInstalled(def.pkg)) continue;
      if (!this.units.has(this.unitName(short))) this._registerUnit(short, def);
    }
    for (const short of DEFAULT_RUNNING_UNITS) {
      const unit = this.getUnit(short);
      if (unit && unit.enabled !== 'static') this._setEnabled(unit, true, { quiet: true });
    }
  }

  /** `systemctl enable|disable` bookkeeping (+ the multi-user.target.wants symlink). */
  _setEnabled(unit, enabled, { quiet = false } = {}) {
    const link = `/etc/systemd/system/multi-user.target.wants/${unit.name}`;
    if (unit.enabled === 'static' || unit.enabled === 'masked') return [];
    const messages = [];
    if (enabled && unit.enabled !== 'enabled') {
      this._mk(link, { target: unit.unitPath, mtime: quiet ? this.installTime : this.now() });
      unit.enabled = 'enabled';
      messages.push(`Created symlink ${link} → ${unit.unitPath}.`);
    } else if (!enabled && unit.enabled === 'enabled') {
      this.nodes.delete(link);
      unit.enabled = 'disabled';
      messages.push(`Removed "${link}".`);
    }
    return messages;
  }

  /** The job id systemd reports in catalog (-x) entries. */
  _allocJob() {
    this.nextJobId += 1 + (this.nextJobId % 3);
    return this.nextJobId;
  }

  _allocPid() {
    this.nextPid += 1 + (fnv1a(this.nextPid) % 7);
    while (this.processes.has(this.nextPid)) this.nextPid += 1;
    return this.nextPid;
  }

  /** The bootstrap: kernel + systemd lines, default units started, student logged in. */
  _bootJournal() {
    const at = (seconds) => this.bootTime + Math.round(seconds * 1000);
    const kernel = [
      `Linux version ${KERNEL_RELEASE} (mockbuild@x86-64-03.build.eng.rdu2.redhat.com) (gcc (GCC) 11.5.0 20240719 (Red Hat 11.5.0-5), GNU ld version 2.35.2-63.el9) ${KERNEL_VERSION}`,
      `Command line: BOOT_IMAGE=(hd0,gpt3)/vmlinuz-${KERNEL_RELEASE} root=UUID=4f2a1c7e-1b9d-4c55-9a51-6d1f0e3b2a77 console=tty0 console=ttyS0,115200n8 no_timer_check net.ifnames=0`,
      'BIOS-provided physical RAM map:',
      'DMI: Red Hat KVM/RHEL, BIOS 1.16.3-2.el9 04/01/2014',
      'Hypervisor detected: KVM',
      'SELinux:  Initializing.',
      'Freeing unused kernel image (initmem) memory: 3812K',
      'virtio_net virtio0 enp1s0: renamed from eth0',
      'XFS (vda4): Mounting V5 Filesystem 4f2a1c7e-1b9d-4c55-9a51-6d1f0e3b2a77',
      'XFS (vda4): Ending clean mount',
    ];
    kernel.forEach((message, index) =>
      this._journalAppend({
        time: at(index * 0.05),
        ident: 'kernel',
        pid: null,
        message,
        priority: index === 5 ? 6 : 6,
        facility: 'kern',
      })
    );
    this._journalAppend({
      time: at(1.9),
      ident: 'systemd',
      pid: 1,
      message:
        'systemd 252-51.el9 running in system mode (+PAM +AUDIT +SELINUX -APPARMOR +IMA +SMACK +SECCOMP +GCRYPT +GNUTLS +OPENSSL +ACL +BLKID +CURL +ELFUTILS +FIDO2 +IDN2 -IDN -IPTC +KMOD +LIBCRYPTSETUP +LIBFDISK +PCRE2 -PWQUALITY +P11KIT -QRENCODE +TPM2 +BZIP2 +LZ4 +XZ +ZLIB +ZSTD -BPF_FRAMEWORK +XKBCOMMON +UTMP +SYSVINIT default-hierarchy=unified)',
      priority: 6,
    });
    this._journalAppend({
      time: at(1.95),
      ident: 'systemd',
      pid: 1,
      message: 'Detected virtualization kvm.',
      priority: 6,
    });
    this._journalAppend({
      time: at(1.96),
      ident: 'systemd',
      pid: 1,
      message: 'Detected architecture x86-64.',
      priority: 6,
    });
    this._journalAppend({
      time: at(2.4),
      ident: 'systemd',
      pid: 1,
      message: `Hostname set to <${this.hostname}>.`,
      priority: 6,
    });
    // System processes that exist from boot (pid 1, kernel threads).
    this._spawnProcess({
      pid: 1,
      ppid: 0,
      user: 'root',
      comm: 'systemd',
      args: '/usr/lib/systemd/systemd rhgb --switched-root --system --deserialize 31',
      start: at(0.5),
      stat: 'Ss',
      rss: 13884,
      vsz: 174996,
      label: 'system_u:system_r:init_t:s0',
      cpuTime: 2.31,
    });
    this._spawnProcess({
      pid: 2,
      ppid: 0,
      user: 'root',
      comm: 'kthreadd',
      args: '[kthreadd]',
      start: at(0.5),
      stat: 'S',
      rss: 0,
      vsz: 0,
      kernel: true,
      label: 'system_u:system_r:kernel_t:s0',
    });
    const kthreads = [
      'rcu_gp',
      'rcu_par_gp',
      'slub_flushwq',
      'netns',
      'kworker/0:0H-events_highpri',
      'mm_percpu_wq',
      'rcu_tasks_kthre',
      'ksoftirqd/0',
      'rcu_preempt',
      'migration/0',
      'cpuhp/0',
      'cpuhp/1',
      'migration/1',
      'ksoftirqd/1',
      'kdevtmpfs',
      'kauditd',
      'khungtaskd',
      'oom_reaper',
      'kcompactd0',
      'ksmd',
      'khugepaged',
      'kswapd0',
      'xfsalloc',
      'xfs-cil/vda4',
    ];
    kthreads.forEach((name, index) =>
      this._spawnProcess({
        pid: 3 + index,
        ppid: 2,
        user: 'root',
        comm: name,
        args: `[${name}]`,
        start: at(0.5),
        stat: /^(rcu_gp|rcu_par_gp|slub|netns|kworker|mm_percpu|xfs)/.test(name) ? 'I<' : 'S',
        rss: 0,
        vsz: 0,
        kernel: true,
        label: 'system_u:system_r:kernel_t:s0',
      })
    );
    // Units in boot order.
    let pid = 612;
    DEFAULT_RUNNING_UNITS.forEach((short, index) => {
      const unit = this.getUnit(short);
      if (!unit) return;
      pid += 4 + (fnv1a(short) % 9) * 3;
      this._startUnit(unit, { at: at(3 + index * 0.35), pid, boot: true });
    });
    this._journalAppend({
      time: at(9.2),
      ident: 'systemd',
      pid: 1,
      message: 'Reached target Multi-User System.',
      priority: 6,
    });
    this._journalAppend({
      time: at(9.3),
      ident: 'systemd',
      pid: 1,
      message:
        'Startup finished in 1.120s (kernel) + 2.474s (initrd) + 6.931s (userspace) = 10.526s.',
      priority: 6,
    });
    // The student's terminal session (ssh from the classroom host).
    const login = at(312);
    this._journalAppend({
      time: login,
      ident: 'sshd',
      pid: 2290,
      message:
        'Accepted publickey for student from 172.25.254.254 port 50822 ssh2: RSA SHA256:Vp5Rf0tTq7uHq0b1JQ3x6m3v9cR2wN8sY4kZ1aL7eDo',
      priority: 6,
      facility: 'authpriv',
    });
    this._journalAppend({
      time: login + 40,
      ident: 'systemd-logind',
      pid: this.getUnit('systemd-logind')?.mainPid || 705,
      message: 'New session 1 of user student.',
      priority: 6,
    });
    this._journalAppend({
      time: login + 60,
      ident: 'systemd',
      pid: 1,
      message: 'Started Session 1 of User student.',
      priority: 6,
    });
    this._journalAppend({
      time: login + 70,
      ident: 'sshd',
      pid: 2290,
      message:
        'pam_unix(sshd:session): session opened for user student(uid=1000) by student(uid=0)',
      priority: 6,
      facility: 'authpriv',
    });
    this._spawnProcess({
      pid: 1460,
      ppid: 1,
      user: 'student',
      comm: 'systemd',
      args: '/usr/lib/systemd/systemd --user',
      start: login,
      stat: 'Ss',
      rss: 11520,
      vsz: 22424,
      label: 'unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023',
    });
    this._spawnProcess({
      pid: 1462,
      ppid: 1460,
      user: 'student',
      comm: '(sd-pam)',
      args: '(sd-pam)',
      start: login,
      stat: 'S',
      rss: 4612,
      vsz: 175400,
      label: 'unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023',
    });
    this._spawnProcess({
      pid: 2290,
      ppid: this.getUnit('sshd')?.mainPid || 1,
      user: 'root',
      comm: 'sshd',
      args: 'sshd: student [priv]',
      start: login,
      stat: 'Ss',
      rss: 10856,
      vsz: 19364,
      label: 'system_u:system_r:sshd_t:s0-s0:c0.c1023',
    });
    this._spawnProcess({
      pid: 2296,
      ppid: 2290,
      user: 'student',
      comm: 'sshd',
      args: 'sshd: student@pts/0',
      start: login,
      stat: 'S',
      rss: 6984,
      vsz: 19364,
      label: 'unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023',
    });
    this._spawnProcess({
      pid: 2297,
      ppid: 2296,
      user: 'student',
      comm: 'bash',
      args: '-bash',
      start: login,
      stat: 'Ss',
      rss: 5224,
      vsz: 224092,
      tty: 'pts/0',
      label: 'unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023',
      shell: true,
    });
    this.shellPid = 2297;
  }

  /**
   * Append a journal entry. `catalog` adds the `-x` explanation; `unit` ties it to
   * `journalctl -u`. Priorities: 3 err, 4 warning, 5 notice, 6 info.
   */
  _journalAppend(entry) {
    const record = {
      time: entry.time ?? this.now(),
      ident: entry.ident || 'systemd',
      pid: entry.pid ?? null,
      unit: entry.unit || null,
      priority: entry.priority ?? 6,
      message: String(entry.message ?? ''),
      catalog: entry.catalog || null,
      facility: entry.facility || (entry.ident === 'kernel' ? 'kern' : 'daemon'),
      seq: this.journal.length,
    };
    if (!entry.internal) this.journal.push(record);
    return record;
  }

  /** Units whose main process runs from boot (for status "since"). */
  _unitStartLines(unit, pid) {
    const short = unit.short;
    if (short === 'httpd') {
      return [
        `AH00558: httpd: Could not reliably determine the server's fully qualified domain name, using ${this.hostname}. Set the 'ServerName' directive globally to suppress this message`,
      ];
    }
    if (short === 'chronyd') {
      return [
        'chronyd version 4.6.1 starting (+CMDMON +NTP +REFCLOCK +RTC +PRIVDROP +SCFILTER +SIGND +ASYNCDNS +NTS +SECHASH +IPV6 +DEBUG)',
        'Loaded seccomp filter (level 2)',
      ];
    }
    if (short === 'sshd') {
      return ['Server listening on 0.0.0.0 port 22.', 'Server listening on :: port 22.'];
    }
    if (short === 'firewalld') return [];
    if (short === 'mariadb')
      return ['/usr/libexec/mariadbd (server 10.5.27-MariaDB) starting as process ' + pid + ' ...'];
    void pid;
    return [];
  }

  _unitPostStartLines(unit) {
    if (unit.short === 'httpd') {
      const ports = this._httpdListenPorts();
      return [`Server configured, listening on: ${ports.map((port) => `port ${port}`).join(', ')}`];
    }
    if (unit.short === 'chronyd')
      return [
        'Selected source 172.25.254.254 (classroom.example.com)',
        'System clock TAI offset set to 37 seconds',
      ];
    return [];
  }

  /**
   * Why a unit would fail to start right now, or null. Order: seed hooks, missing binary,
   * built-in config validators, port conflicts, SELinux port labels.
   */
  _unitFailure(unit) {
    const def = unit.def || {};
    for (const hook of unit.failWhen || []) {
      const failure = this._evaluateFailHook(hook, unit);
      if (failure) return failure;
    }
    if (unit.custom) {
      const exec = String(def.exec || '')
        .replace(/^[-@+!:]+/, '')
        .split(/\s+/)[0];
      if (exec) {
        const found = this.stat(exec, { user: 'root' });
        if (!found.ok) {
          return {
            systemdLines: [
              `${unit.name}: Failed to locate executable ${exec}: No such file or directory`,
              `${unit.name}: Failed at step EXEC spawning ${exec}: No such file or directory`,
            ],
            status: 203,
            statusText: 'EXEC',
          };
        }
        if (!(found.node.mode & 0o111)) {
          return {
            systemdLines: [
              `${unit.name}: Failed to execute ${exec}: Permission denied`,
              `${unit.name}: Failed at step EXEC spawning ${exec}: Permission denied`,
            ],
            status: 203,
            statusText: 'EXEC',
          };
        }
      }
    }
    if (def.validator === 'httpd') {
      const error = this.httpdConfigError();
      if (error) return { lines: error.lines, status: 1 };
      const ports = this._httpdListenPorts();
      for (const port of ports) {
        const holder = this.listeningSockets().find(
          (socket) => socket.proto === 'tcp' && socket.port === port && socket.owner !== unit.name
        );
        if (holder) {
          return {
            lines: [
              `(98)Address already in use: AH00072: make_sock: could not bind to address [::]:${port}`,
              `(98)Address already in use: AH00072: make_sock: could not bind to address 0.0.0.0:${port}`,
              'no listening sockets available, shutting down',
              'AH00015: Unable to open logs',
            ],
            status: 1,
          };
        }
        if (this.selinux.mode === 'enforcing' && !this.portAllowedFor('httpd_t', 'tcp', port)) {
          this._recordDenial({
            perm: 'name_bind',
            comm: 'httpd',
            name: '',
            tclass: 'tcp_socket',
            scontext: 'system_u:system_r:httpd_t:s0',
            tcontext: `system_u:object_r:${this.portType('tcp', port)}:s0`,
            src: port,
          });
          return {
            lines: [
              `(13)Permission denied: AH00072: make_sock: could not bind to address [::]:${port}`,
              `(13)Permission denied: AH00072: make_sock: could not bind to address 0.0.0.0:${port}`,
              'no listening sockets available, shutting down',
              'AH00015: Unable to open logs',
            ],
            status: 1,
          };
        }
      }
    }
    if (def.validator === 'sshd') {
      const error = this.sshdConfigError();
      if (error) return { lines: error.lines, status: 255 };
    }
    for (const [proto, port] of def.ports || []) {
      const holder = this.listeningSockets().find(
        (socket) => socket.proto === proto && socket.port === port && socket.owner !== unit.name
      );
      if (holder) {
        return {
          lines: [`bind() to 0.0.0.0:${port} failed (98: Address already in use)`],
          status: 1,
        };
      }
    }
    return null;
  }

  _evaluateFailHook(hook, unit) {
    if (!hook || typeof hook !== 'object') return null;
    const template = (lines, vars) =>
      (Array.isArray(lines) ? lines : lines ? [lines] : []).map((line) =>
        String(line).replace(/\{(\w+)\}/g, (match, key) =>
          vars[key] !== undefined ? String(vars[key]) : match
        )
      );
    const status = Number.isFinite(Number(hook.status)) ? Number(hook.status) : 1;
    if (hook.missing) {
      const found = this.stat(hook.missing, { user: 'root' });
      if (!found.ok)
        return { lines: template(hook.journal, { file: hook.missing }), status, rawLines: true };
      return null;
    }
    const file = hook.file || hook.notMatches?.file;
    if (!file) return null;
    const read = this.readFile(file, { user: 'root' });
    const content = read.ok ? read.content : '';
    if (!read.ok) return { lines: template(hook.journal, { file }), status, rawLines: true };
    const pattern = hook.matches ?? null;
    const negative = hook.notMatches;
    if (pattern !== null) {
      let regex;
      try {
        regex = new RegExp(pattern, 'm');
      } catch {
        return null;
      }
      const lines = content.split('\n');
      const index = lines.findIndex((line) => regex.test(line));
      if (index >= 0 || regex.test(content)) {
        const lineNo = index >= 0 ? index + 1 : 1;
        return {
          lines: template(hook.journal, {
            file,
            line: lineNo,
            text: (lines[index] || '').trim(),
            match: (content.match(regex) || [''])[0],
          }),
          status,
          rawLines: true,
        };
      }
      return null;
    }
    if (negative) {
      const negativePattern = typeof negative === 'string' ? negative : negative.pattern;
      let regex;
      try {
        regex = new RegExp(negativePattern, 'm');
      } catch {
        return null;
      }
      if (!regex.test(content))
        return { lines: template(hook.journal, { file }), status, rawLines: true };
    }
    void unit;
    return null;
  }

  /**
   * Start a unit. Records the real journal sequence. Returns `{ok}` or
   * `{error: 'failed'|'masked'|'not-found'}`.
   */
  _startUnit(unit, { at, pid, boot = false } = {}) {
    if (!unit) return { error: 'not-found' };
    if (unit.enabled === 'masked') return { error: 'masked' };
    if (unit.active === 'active') return { ok: true, already: true };
    const time = at ?? this.now();
    const def = unit.def || {};
    const job = this._allocJob();
    const mainPid = pid ?? this._allocPid();
    const ident =
      def.comm === 'systemd-journal'
        ? 'systemd-journald'
        : (def.comm || unit.short).replace(/:.*$/, '');
    if (!boot || def.type !== 'idle') {
      this._journalAppend({
        time,
        ident: 'systemd',
        pid: 1,
        unit: unit.name,
        message: `Starting ${def.description || unit.name}...`,
        priority: 6,
        catalog: { type: 'start-begin', unit: unit.name, job },
      });
    }
    const failure = boot ? null : this._unitFailure(unit);
    if (failure) {
      const statusNumber = failure.status ?? 1;
      const statusText =
        failure.statusText ||
        (statusNumber === 1
          ? 'FAILURE'
          : statusNumber === 203
            ? 'EXEC'
            : statusNumber === 255
              ? 'EXCEPTION'
              : String(statusNumber));
      for (const line of failure.lines || []) {
        this._journalAppend({
          time: time + 20,
          ident,
          pid: mainPid,
          unit: unit.name,
          message: line,
          priority: 6,
        });
      }
      for (const line of failure.systemdLines || []) {
        this._journalAppend({
          time: time + 21,
          ident: 'systemd',
          pid: 1,
          unit: unit.name,
          message: line,
          priority: 3,
        });
      }
      this._journalAppend({
        time: time + 25,
        ident: 'systemd',
        pid: 1,
        unit: unit.name,
        message: `${unit.name}: Main process exited, code=exited, status=${statusNumber}/${statusText}`,
        priority: 5,
        catalog: { type: 'process-exited', unit: unit.name, code: 'exited', status: statusNumber },
      });
      this._journalAppend({
        time: time + 26,
        ident: 'systemd',
        pid: 1,
        unit: unit.name,
        message: `${unit.name}: Failed with result 'exit-code'.`,
        priority: 4,
        catalog: { type: 'unit-failed', unit: unit.name, result: 'exit-code' },
      });
      this._journalAppend({
        time: time + 27,
        ident: 'systemd',
        pid: 1,
        unit: unit.name,
        message: `Failed to start ${def.description || unit.name}.`,
        priority: 3,
        catalog: { type: 'start-failed', unit: unit.name, job },
      });
      unit.active = 'failed';
      unit.sub = 'failed';
      unit.result = 'exit-code';
      unit.exitStatus = statusNumber;
      unit.exitStatusText = statusText;
      unit.failedPid = mainPid;
      unit.since = time + 27;
      unit.mainPid = null;
      unit.pids = [];
      unit.activeEnter = null;
      unit.cpuMs = 18 + (fnv1a(unit.name) % 40);
      return { error: 'failed', job };
    }
    for (const line of this._unitStartLines(unit, mainPid)) {
      this._journalAppend({
        time: time + 40,
        ident,
        pid: mainPid,
        unit: unit.name,
        message: line,
        priority: 6,
      });
    }
    const label = `system_u:system_r:${def.label || 'unconfined_service_t'}:s0`;
    this._spawnProcess({
      pid: mainPid,
      ppid: 1,
      user: def.user || 'root',
      comm: def.comm || unit.short,
      args: def.cmd || def.exec || unit.short,
      start: time + 30,
      stat: def.workers?.length ? 'Ss' : 'Ssl',
      rss: def.rss ?? 4000 + (fnv1a(unit.name) % 40000),
      vsz: def.vsz ?? 20000 + (fnv1a(`${unit.name}-vsz`) % 400000),
      unit: unit.name,
      label,
      tty: def.tty || '?',
      cpu: def.cpu ?? 0,
      mem: def.mem,
    });
    const pids = [mainPid];
    for (const [comm, args, user] of def.workers || []) {
      const workerPid = this._allocPid();
      pids.push(workerPid);
      this._spawnProcess({
        pid: workerPid,
        ppid: mainPid,
        user: user || def.user || 'root',
        comm,
        args,
        start: time + 35,
        stat: 'S',
        rss: 2000 + (fnv1a(`${unit.name}-${workerPid}`) % 20000),
        vsz: 30000 + (fnv1a(`${workerPid}`) % 900000),
        unit: unit.name,
        label,
      });
    }
    this._journalAppend({
      time: time + 50,
      ident: 'systemd',
      pid: 1,
      unit: unit.name,
      message: `Started ${def.description || unit.name}.`,
      priority: 6,
      catalog: { type: 'start-done', unit: unit.name, job },
    });
    for (const line of this._unitPostStartLines(unit)) {
      this._journalAppend({
        time: time + 52,
        ident,
        pid: mainPid,
        unit: unit.name,
        message: line,
        priority: 6,
      });
    }
    unit.active = 'active';
    unit.sub = 'running';
    unit.result = 'success';
    unit.exitStatus = 0;
    unit.mainPid = mainPid;
    unit.pids = pids;
    unit.since = time + 50;
    unit.activeEnter = time + 50;
    unit.cpuMs = 40 + (fnv1a(unit.name) % 900);
    if (unit.short === 'chronyd') this.timeSync.synced = true;
    return { ok: true, job };
  }

  _stopUnit(unit, { at, quiet = false } = {}) {
    if (!unit) return { error: 'not-found' };
    const time = at ?? this.now();
    const def = unit.def || {};
    if (unit.active !== 'active') {
      if (unit.active === 'failed') {
        // systemctl stop on a failed unit keeps the failed state until reset-failed/start.
        return { ok: true, already: true };
      }
      return { ok: true, already: true };
    }
    const job = this._allocJob();
    if (!quiet) {
      this._journalAppend({
        time,
        ident: 'systemd',
        pid: 1,
        unit: unit.name,
        message: `Stopping ${def.description || unit.name}...`,
        priority: 6,
        catalog: { type: 'stop-begin', unit: unit.name, job },
      });
    }
    for (const pid of unit.pids || []) this.processes.delete(pid);
    if (!quiet) {
      this._journalAppend({
        time: time + 30,
        ident: 'systemd',
        pid: 1,
        unit: unit.name,
        message: `${unit.name}: Deactivated successfully.`,
        priority: 6,
        catalog: { type: 'unit-succeeded', unit: unit.name },
      });
      this._journalAppend({
        time: time + 31,
        ident: 'systemd',
        pid: 1,
        unit: unit.name,
        message: `Stopped ${def.description || unit.name}.`,
        priority: 6,
        catalog: { type: 'stop-done', unit: unit.name, job },
      });
    }
    unit.active = 'inactive';
    unit.sub = 'dead';
    unit.result = 'success';
    unit.mainPid = null;
    unit.pids = [];
    unit.since = time + 31;
    unit.lastRunStart = unit.activeEnter;
    unit.activeEnter = null;
    if (unit.short === 'chronyd') this.timeSync.synced = false;
    return { ok: true, job };
  }

  /** The systemctl verbs (as root). Returns `{ok, messages}` or `{error, …}`. */
  startUnit(name) {
    this.sync();
    const unit = this.getUnit(name);
    if (!unit) return { error: 'not-found' };
    if (unit.active === 'active') return { ok: true, already: true };
    return this._startUnit(unit);
  }

  stopUnit(name) {
    this.sync();
    const unit = this.getUnit(name);
    if (!unit) return { error: 'not-found' };
    if (unit.active === 'failed') {
      unit.active = 'failed';
      return { ok: true };
    }
    return this._stopUnit(unit);
  }

  restartUnit(name) {
    this.sync();
    const unit = this.getUnit(name);
    if (!unit) return { error: 'not-found' };
    if (unit.enabled === 'masked') return { error: 'masked' };
    if (unit.active === 'active') this._stopUnit(unit);
    return this._startUnit(unit);
  }

  reloadUnit(name) {
    this.sync();
    const unit = this.getUnit(name);
    if (!unit) return { error: 'not-found' };
    if (unit.active !== 'active') return { error: 'not-active' };
    if (!unit.def?.reload) return { error: 'no-reload' };
    const failure = this._unitFailure(unit);
    const time = this.now();
    this._journalAppend({
      time,
      ident: 'systemd',
      pid: 1,
      unit: unit.name,
      message: `Reloading ${unit.def.description}...`,
      priority: 6,
    });
    if (failure) {
      for (const line of failure.lines || [])
        this._journalAppend({
          time: time + 5,
          ident: unit.def.comm || unit.short,
          pid: this._allocPid(),
          unit: unit.name,
          message: line,
          priority: 6,
        });
      this._journalAppend({
        time: time + 6,
        ident: 'systemd',
        pid: 1,
        unit: unit.name,
        message: `${unit.name}: Control process exited, code=exited, status=1/FAILURE`,
        priority: 5,
      });
      this._journalAppend({
        time: time + 7,
        ident: 'systemd',
        pid: 1,
        unit: unit.name,
        message: `Reload failed for ${unit.def.description}.`,
        priority: 3,
      });
      return { error: 'reload-failed' };
    }
    this._journalAppend({
      time: time + 20,
      ident: 'systemd',
      pid: 1,
      unit: unit.name,
      message: `Reloaded ${unit.def.description}.`,
      priority: 6,
    });
    return { ok: true };
  }

  enableUnit(name, { now = false } = {}) {
    this.sync();
    const unit = this.getUnit(name);
    if (!unit) return { error: 'not-found' };
    if (unit.enabled === 'masked') return { error: 'masked' };
    if (unit.enabled === 'static') return { error: 'static' };
    const messages = this._setEnabled(unit, true);
    if (now) {
      const started = unit.active === 'active' ? { ok: true } : this._startUnit(unit);
      if (started.error) return { ...started, messages };
    }
    return { ok: true, messages };
  }

  disableUnit(name, { now = false } = {}) {
    this.sync();
    const unit = this.getUnit(name);
    if (!unit) return { error: 'not-found' };
    const messages = this._setEnabled(unit, false);
    if (now && unit.active === 'active') this._stopUnit(unit);
    return { ok: true, messages };
  }

  maskUnit(name) {
    const unit = this.getUnit(name);
    if (!unit) return { error: 'not-found' };
    const messages = [];
    if (unit.enabled === 'enabled') messages.push(...this._setEnabled(unit, false));
    this._mk(`/etc/systemd/system/${unit.name}`, { target: '/dev/null', mtime: this.now() });
    unit.enabledBeforeMask = unit.enabled;
    unit.enabled = 'masked';
    messages.push(`Created symlink /etc/systemd/system/${unit.name} → /dev/null.`);
    return { ok: true, messages };
  }

  unmaskUnit(name) {
    const unit = this.getUnit(name);
    if (!unit) return { error: 'not-found' };
    if (unit.enabled !== 'masked') return { ok: true, messages: [] };
    this.nodes.delete(`/etc/systemd/system/${unit.name}`);
    unit.enabled = unit.preset === 'static' ? 'static' : 'disabled';
    return { ok: true, messages: [`Removed "/etc/systemd/system/${unit.name}".`] };
  }

  resetFailed(name) {
    for (const unit of this.units.values()) {
      if (name && unit.name !== this.unitName(name)) continue;
      if (unit.active === 'failed') {
        unit.active = 'inactive';
        unit.sub = 'dead';
      }
    }
    return { ok: true };
  }

  /** `systemctl daemon-reload`: (re)load custom units from /etc/systemd/system/*.service. */
  daemonReload() {
    this.sync();
    for (const [path, node] of [...this.nodes]) {
      if (!path.startsWith('/etc/systemd/system/') || node.type !== 'file') continue;
      if (path.split('/').length !== 5 || !path.endsWith('.service')) continue;
      const parsed = this._parseUnitFile(this._content(path, node));
      const short = basenameOf(path).replace(/\.service$/, '');
      const existing = this.units.get(`${short}.service`);
      const def = {
        description: parsed.Description || `${short}.service`,
        exec: parsed.ExecStart || '',
        cmd: String(parsed.ExecStart || '').replace(/^[-@+!:]+/, ''),
        comm: basenameOf(
          String(parsed.ExecStart || short)
            .replace(/^[-@+!:]+/, '')
            .split(/\s+/)[0]
        ).slice(0, 15),
        type: parsed.Type || 'simple',
        user: parsed.User || 'root',
        restart: parsed.Restart || 'no',
        wantedBy: parsed.WantedBy || 'multi-user.target',
        preset: 'disabled',
        label: 'unconfined_service_t',
      };
      const unit = this._registerUnit(short, def, { custom: true, path });
      if (existing) unit.failWhen = existing.failWhen || [];
    }
    for (const unit of this.units.values()) unit.needsReload = false;
    this._journalAppend({ ident: 'systemd', pid: 1, message: 'Reloading.', priority: 6 });
    return { ok: true };
  }

  _parseUnitFile(text) {
    const result = {};
    for (const raw of String(text || '').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      result[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return result;
  }

  // ── httpd / sshd configuration validators ────────────────────────────────

  _httpdConfigFiles() {
    const files = ['/etc/httpd/conf/httpd.conf'];
    const conf = this.readdir('/etc/httpd/conf.d', { user: 'root' });
    if (conf.ok) {
      for (const entry of conf.entries) {
        if (entry.node.type === 'file' && entry.name.endsWith('.conf')) files.push(entry.path);
      }
    }
    return files;
  }

  /** First `httpd -t` error (`{file, line, lines}`) or null. */
  httpdConfigError() {
    if (!this.isInstalled('httpd')) return null;
    for (const file of this._httpdConfigFiles()) {
      const read = this.readFile(file, { user: 'root' });
      if (!read.ok) {
        if (file.endsWith('httpd.conf')) {
          return {
            file,
            line: 0,
            lines: [`httpd: Could not open configuration file ${file}: No such file or directory`],
          };
        }
        continue;
      }
      const stack = [];
      const lines = read.content.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const text = lines[index].trim();
        if (!text || text.startsWith('#')) continue;
        const syntax = (message) => ({
          file,
          line: index + 1,
          lines: [`AH00526: Syntax error on line ${index + 1} of ${file}:`, message],
        });
        const close = text.match(/^<\/\s*([A-Za-z]+)\s*>$/);
        if (close) {
          const name = close[1];
          const open = stack.pop();
          if (!open || open.name.toLowerCase() !== name.toLowerCase()) {
            if (!open) return syntax(`</${name}> without matching <${name}> section`);
            return syntax(`Expected </${open.name}> but saw </${name}>`);
          }
          continue;
        }
        const openTag = text.match(/^<\s*([A-Za-z]+)(\s[^>]*)?>$/);
        if (openTag) {
          const name = openTag[1];
          if (!HTTPD_SECTIONS.has(name.toLowerCase())) {
            return syntax(
              `Invalid command '<${name}', perhaps misspelled or defined by a module not included in the server configuration`
            );
          }
          stack.push({ name, line: index + 1 });
          continue;
        }
        if (text.startsWith('<'))
          return syntax(
            `Invalid command '${text.split(/\s+/)[0]}', perhaps misspelled or defined by a module not included in the server configuration`
          );
        const directive = text.split(/\s+/)[0];
        if (!HTTPD_DIRECTIVES.has(directive.toLowerCase())) {
          return syntax(
            `Invalid command '${directive}', perhaps misspelled or defined by a module not included in the server configuration`
          );
        }
        const args = text.slice(directive.length).trim();
        if (directive.toLowerCase() === 'listen') {
          const port = args.split(':').pop();
          if (!/^\d+$/.test(port || '') || Number(port) < 1 || Number(port) > 65535) {
            return syntax('Port must be specified');
          }
        }
        if (
          directive.toLowerCase() === 'require' &&
          /^all\b/i.test(args) &&
          !/^all\s+(granted|denied)\s*$/i.test(args)
        ) {
          return syntax("'Require all' does not take an argument other than 'granted' or 'denied'");
        }
      }
      if (stack.length) {
        const open = stack[stack.length - 1];
        return {
          file,
          line: open.line,
          lines: [
            `AH00526: Syntax error on line ${open.line} of ${file}:`,
            `<${open.name}> was not closed.`,
          ],
        };
      }
    }
    return null;
  }

  _httpdDirectiveValues(name) {
    const values = [];
    for (const file of this._httpdConfigFiles()) {
      const read = this.readFile(file, { user: 'root' });
      if (!read.ok) continue;
      for (const line of read.content.split('\n')) {
        const text = line.trim();
        const match = text.match(/^(\S+)\s+(.*)$/);
        if (match && match[1].toLowerCase() === name.toLowerCase())
          values.push(match[2].trim().replace(/^"|"$/g, ''));
      }
    }
    return values;
  }

  _httpdListenPorts() {
    const ports = this._httpdDirectiveValues('Listen')
      .map((value) => Number(String(value).split(/\s+/)[0].split(':').pop()))
      .filter((port) => Number.isFinite(port) && port > 0);
    return ports.length ? [...new Set(ports)] : [80];
  }

  httpdDocumentRoot() {
    const values = this._httpdDirectiveValues('DocumentRoot');
    return values.length ? values[values.length - 1] : '/var/www/html';
  }

  /** Warnings `httpd -t` prints before "Syntax OK". */
  httpdConfigWarnings() {
    const warnings = [];
    const hasServerName = this._httpdDirectiveValues('ServerName').length > 0;
    if (!hasServerName) {
      warnings.push(
        `AH00558: httpd: Could not reliably determine the server's fully qualified domain name, using ${this.hostname}. Set the 'ServerName' directive globally to suppress this message`
      );
    }
    const root = this.httpdDocumentRoot();
    if (!this.stat(root, { user: 'root' }).ok)
      warnings.push(`AH00112: Warning: DocumentRoot [${root}] does not exist`);
    return warnings;
  }

  sshdConfigError() {
    const file = '/etc/ssh/sshd_config';
    const read = this.readFile(file, { user: 'root' });
    if (!read.ok) return { lines: [`${file}: No such file or directory`] };
    const lines = read.content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index].trim();
      if (!text || text.startsWith('#')) continue;
      const keyword = text.split(/\s+/)[0];
      if (!SSHD_KEYWORDS.has(keyword.toLowerCase())) {
        return {
          lines: [
            `${file}: line ${index + 1}: Bad configuration option: ${keyword}`,
            `${file}: terminating, 1 bad configuration options`,
          ],
        };
      }
    }
    return null;
  }

  // ── processes ────────────────────────────────────────────────────────────

  _spawnProcess(spec) {
    const pid = spec.pid ?? this._allocPid();
    const process = {
      pid,
      ppid: spec.ppid ?? 1,
      user: spec.user || 'root',
      comm: String(spec.comm || basenameOf(String(spec.args || 'process').split(/\s+/)[0])).slice(
        0,
        15
      ),
      args: spec.args || spec.comm || 'process',
      start: spec.start ?? this.now(),
      stat: spec.stat || 'S',
      cpu: Number(spec.cpu ?? 0),
      mem: spec.mem,
      rss: spec.rss ?? 1800,
      vsz: spec.vsz ?? 221000,
      tty: spec.tty || '?',
      unit: spec.unit || null,
      container: spec.container || null,
      label: spec.label || 'unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023',
      nice: spec.nice ?? 0,
      ignoreTerm: Boolean(spec.ignoreTerm),
      kernel: Boolean(spec.kernel),
      seeded: Boolean(spec.seeded),
      cpuTime: spec.cpuTime,
      shell: Boolean(spec.shell),
    };
    this.processes.set(pid, process);
    if (pid >= this.nextPid) this.nextPid = pid + 1;
    return process;
  }

  /** Accumulated CPU seconds of a process (busy processes burn their %CPU of wall time). */
  cpuSeconds(process) {
    const elapsed = Math.max(0, (this.now() - process.start) / 1000);
    if (process.cpu >= 1) return (elapsed * process.cpu) / 100;
    if (Number.isFinite(process.cpuTime)) return process.cpuTime;
    return Math.min(elapsed, (fnv1a(process.pid) % 400) / 100);
  }

  /** %MEM of a process. */
  memPercent(process) {
    if (Number.isFinite(process.mem)) return process.mem;
    return Math.round(((process.rss || 0) / MEMORY_TOTAL_KIB) * 1000) / 10;
  }

  /** All live processes sorted by pid (kernel threads included). */
  listProcesses() {
    return [...this.processes.values()].sort((a, b) => a.pid - b.pid);
  }

  findProcesses(pattern, { full = false, user, exact = false } = {}) {
    let regex;
    try {
      regex = new RegExp(exact ? `^(?:${pattern})$` : pattern);
    } catch {
      regex = new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
    return this.listProcesses().filter((process) => {
      if (user && process.user !== user) return false;
      return regex.test(full ? process.args : process.comm);
    });
  }

  /**
   * kill(2): `{ok, process}` or `{error: 'ESRCH'|'EPERM'}`. SIGTERM/SIGINT/SIGHUP/SIGKILL end
   * the process (unless it ignores TERM); killing a unit's main process updates the unit.
   */
  kill(pid, signal = 15, { user } = {}) {
    this.sync();
    const process = this.processes.get(Number(pid));
    if (!process || (process.kernel && Number(signal) !== 0)) {
      if (process?.kernel) return { error: 'EPERM' };
      return { error: 'ESRCH' };
    }
    const ident = this._ident(user);
    if (ident.uid !== 0 && process.user !== ident.name) return { error: 'EPERM' };
    const sig = Number(signal);
    if (sig === 0) return { ok: true, process };
    if ([18, 19, 20, 28].includes(sig)) {
      process.stat = sig === 19 || sig === 20 ? 'T' : process.stat.replace('T', 'S');
      return { ok: true, process };
    }
    if (sig === 15 && process.ignoreTerm) return { ok: true, process, ignored: true };
    if (process.pid === 1) return { ok: true, process, ignored: true };
    if (process.shell && sig !== 9) return { ok: true, process, ignored: true };
    this.processes.delete(process.pid);
    for (const child of this.listProcesses()) {
      if (child.ppid === process.pid && !child.unit) this.processes.delete(child.pid);
    }
    if (process.unit) this._unitProcessDied(process, sig);
    if (process.container) this._containerProcessDied(process, sig);
    return { ok: true, process };
  }

  _unitProcessDied(process, sig) {
    const unit = this.units.get(process.unit);
    if (!unit || unit.mainPid !== process.pid) return;
    const time = this.now();
    for (const pid of unit.pids) this.processes.delete(pid);
    const signalName = SIGNAL_NAMES[sig] || String(sig);
    if (sig === 9) {
      this._journalAppend({
        time,
        ident: 'systemd',
        pid: 1,
        unit: unit.name,
        message: `${unit.name}: Main process exited, code=killed, status=9/KILL`,
        priority: 5,
        catalog: { type: 'process-exited', unit: unit.name, code: 'killed', status: 9 },
      });
      this._journalAppend({
        time: time + 1,
        ident: 'systemd',
        pid: 1,
        unit: unit.name,
        message: `${unit.name}: Failed with result 'signal'.`,
        priority: 4,
        catalog: { type: 'unit-failed', unit: unit.name, result: 'signal' },
      });
      unit.active = 'failed';
      unit.sub = 'failed';
      unit.result = 'signal';
      unit.exitStatus = 9;
      unit.exitStatusText = 'KILL';
      unit.killedSignal = signalName;
    } else {
      this._journalAppend({
        time,
        ident: 'systemd',
        pid: 1,
        unit: unit.name,
        message: `${unit.name}: Deactivated successfully.`,
        priority: 6,
        catalog: { type: 'unit-succeeded', unit: unit.name },
      });
      unit.active = 'inactive';
      unit.sub = 'dead';
      unit.result = 'success';
    }
    unit.failedPid = process.pid;
    unit.mainPid = null;
    unit.pids = [];
    unit.since = time + 1;
    const restart = unit.def?.restart || 'no';
    if (restart === 'always' || (restart === 'on-failure' && sig === 9)) {
      this._journalAppend({
        time: time + 2,
        ident: 'systemd',
        pid: 1,
        unit: unit.name,
        message: `${unit.name}: Scheduled restart job, restart counter is at 1.`,
        priority: 6,
      });
      this._startUnit(unit, { at: time + 3 });
    }
  }

  /** Load average (1/5/15 min): base noise + one per busy process, ramping with its age. */
  loadAverage() {
    const base = [0.08, 0.03, 0.01];
    const now = this.now();
    const busy = [...this.processes.values()].filter((process) => process.cpu >= 50);
    return base.map((value, index) => {
      const period = [60, 300, 900][index] * 1000;
      let load = value;
      for (const process of busy) {
        const age = Math.max(0, now - process.start);
        load += (process.cpu / 100) * (1 - Math.exp(-age / period));
      }
      return Math.round(load * 100) / 100;
    });
  }

  memory() {
    const used =
      512000 +
      [...this.processes.values()].reduce(
        (sum, process) => sum + (process.kernel ? 0 : process.rss || 0),
        0
      ) /
        4;
    const cache = 773248;
    const total = MEMORY_TOTAL_KIB;
    const shared = 12544;
    const free = Math.max(0, Math.round(total - used - cache));
    return {
      total,
      used: Math.round(used),
      free,
      shared,
      cache,
      available: Math.round(free + cache * 0.75),
    };
  }

  // ── network ──────────────────────────────────────────────────────────────

  interfaces() {
    return [
      {
        index: 1,
        name: 'lo',
        flags: 'LOOPBACK,UP,LOWER_UP',
        mtu: 65536,
        qdisc: 'noqueue',
        state: 'UNKNOWN',
        linkType: 'loopback',
        mac: '00:00:00:00:00:00',
        brd: '00:00:00:00:00:00',
        inet: [{ address: '127.0.0.1', prefix: 8, scope: 'host', label: 'lo' }],
        inet6: [{ address: '::1', prefix: 128, scope: 'host', noprefixroute: true }],
      },
      {
        index: 2,
        name: 'eth0',
        flags: 'BROADCAST,MULTICAST,UP,LOWER_UP',
        mtu: 1500,
        qdisc: 'fq_codel',
        state: 'UP',
        linkType: 'ether',
        mac: WORKSTATION_MAC,
        brd: 'ff:ff:ff:ff:ff:ff',
        altname: 'enp1s0',
        inet: [
          {
            address: WORKSTATION_IP,
            prefix: 24,
            brdAddr: '172.25.250.255',
            scope: 'global',
            noprefixroute: true,
            label: 'eth0',
          },
        ],
        inet6: [
          { address: 'fe80::5054:ff:fe00:fa09', prefix: 64, scope: 'link', noprefixroute: true },
        ],
      },
    ];
  }

  routes() {
    return [
      { dest: 'default', via: GATEWAY_IP, dev: 'eth0', proto: 'static', metric: 100 },
      {
        dest: '172.25.250.0/24',
        dev: 'eth0',
        proto: 'kernel',
        scope: 'link',
        src: WORKSTATION_IP,
        metric: 100,
      },
    ];
  }

  /** /etc/hosts lookup (parsed from the live file, so edits matter). */
  resolveHostsFile(name) {
    const read = this.readFile('/etc/hosts', { user: 'root' });
    if (!read.ok) return null;
    const wanted = String(name).toLowerCase().replace(/\.$/, '');
    for (const raw of read.content.split('\n')) {
      const line = raw.replace(/#.*/, '').trim();
      if (!line) continue;
      const [ip, ...names] = line.split(/\s+/);
      if (names.some((entry) => entry.toLowerCase() === wanted)) return { ip, names, line: raw };
    }
    return null;
  }

  /** The search domains + nameserver from /etc/resolv.conf. */
  resolvConf() {
    const read = this.readFile('/etc/resolv.conf', { user: 'root' });
    const result = { search: [], nameservers: [] };
    if (!read.ok) return result;
    for (const raw of read.content.split('\n')) {
      const line = raw.replace(/#.*/, '').trim();
      const [key, ...values] = line.split(/\s+/);
      if (key === 'search' || key === 'domain') result.search.push(...values);
      if (key === 'nameserver' && values[0]) result.nameservers.push(values[0]);
    }
    return result;
  }

  /** DNS A record (lab nameserver): exact names, then wildcard zones. */
  dnsLookup(name) {
    const wanted = String(name || '')
      .toLowerCase()
      .replace(/\.$/, '');
    if (!wanted) return null;
    if (this.dns.has(wanted)) return { name: wanted, ip: this.dns.get(wanted) };
    for (const [zone, ip] of this.dnsWildcards) {
      if (wanted.endsWith(`.${zone}`)) return { name: wanted, ip, wildcard: zone };
    }
    return null;
  }

  /** DNS lookup with the resolv.conf search list for short names (host/nslookup). */
  dnsLookupWithSearch(name) {
    const direct = String(name || '').replace(/\.$/, '');
    if (direct.includes('.')) {
      const found = this.dnsLookup(direct);
      if (found) return found;
    }
    for (const domain of this.resolvConf().search) {
      const found = this.dnsLookup(`${direct}.${domain}`);
      if (found) return found;
    }
    return direct.includes('.') ? null : this.dnsLookup(direct);
  }

  /** getaddrinfo(): nsswitch `files dns myhostname`. */
  resolveName(name) {
    const text = String(name || '')
      .trim()
      .toLowerCase()
      .replace(/\.$/, '');
    if (!text) return null;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(text)) return { ip: text, source: 'literal', name: text };
    const hosts = this.resolveHostsFile(text);
    if (hosts) return { ip: hosts.ip, source: 'hosts', name: hosts.names[0] || text };
    const dns = this.dnsLookupWithSearch(text);
    if (dns) return { ip: dns.ip, source: 'dns', name: dns.name };
    if (text === this.hostname || text === this.hostname.split('.')[0])
      return { ip: WORKSTATION_IP, source: 'myhostname', name: this.hostname };
    return null;
  }

  /** Reverse lookup for ping/ss output. */
  reverseName(ip) {
    const hosts = this.readFile('/etc/hosts', { user: 'root' });
    if (hosts.ok) {
      for (const raw of hosts.content.split('\n')) {
        const [address, first] = raw.replace(/#.*/, '').trim().split(/\s+/);
        if (address === ip && first) return first;
      }
    }
    for (const [name, address] of this.dns) if (address === ip) return name;
    return null;
  }

  isLocalAddress(ip) {
    return (
      ['127.0.0.1', '::1', WORKSTATION_IP, '0.0.0.0'].includes(String(ip)) ||
      String(ip).startsWith('127.')
    );
  }

  isReachable(ip) {
    return this.isLocalAddress(ip) || this.reachable.has(String(ip));
  }

  /**
   * Listening sockets: running units' ports (httpd follows its Listen lines) and the
   * published ports of running rootless containers (held by pasta).
   * @returns {Array<{proto: string, addr: string, port: number, owner: string, comm: string, pid: number, fd: number, user: string, backlog: number}>}
   */
  listeningSockets() {
    const sockets = [];
    for (const unit of this.units.values()) {
      if (unit.active !== 'active') continue;
      const def = unit.def || {};
      let ports = def.ports || [];
      if (def.validator === 'httpd')
        ports = this._httpdListenPorts().map((port) => ['tcp', port, '*']);
      for (const [proto, port, addr] of ports) {
        sockets.push({
          proto,
          addr: addr || '*',
          port,
          owner: unit.name,
          comm: def.comm || unit.short,
          pid: unit.mainPid,
          fd: 3 + (sockets.length % 4),
          user: def.user || 'root',
          backlog:
            proto === 'udp'
              ? 0
              : def.validator === 'httpd'
                ? 511
                : def.short === 'mariadb'
                  ? 80
                  : 128,
          extraPids: def.workers?.length ? unit.pids.slice(1) : [],
        });
      }
    }
    for (const [owner, store] of Object.entries(this.podman)) {
      for (const container of store.containers.values()) {
        if (container.state !== 'running') continue;
        for (const port of container.ports) {
          sockets.push({
            proto: port.proto || 'tcp',
            addr: port.hostIp && port.hostIp !== '0.0.0.0' ? port.hostIp : '0.0.0.0',
            port: port.hostPort,
            owner: `container:${container.id}`,
            comm: owner === 'root' ? 'conmon' : 'pasta.avx2',
            pid: container.netPid || container.pid,
            fd: 6,
            user: owner === 'root' ? 'root' : 'student',
            backlog: 128,
            container,
          });
        }
      }
    }
    return sockets;
  }

  /** ICMP echo: `{ok, ip, name}` / `{error: 'unknown-host'|'unreachable'}`. */
  ping(target) {
    const resolved = this.resolveName(target);
    if (!resolved) return { error: 'unknown-host' };
    return {
      ok: this.isReachable(resolved.ip),
      ip: resolved.ip,
      name: resolved.source === 'literal' ? null : resolved.name,
      reverse: this.reverseName(resolved.ip),
      onLink: resolved.ip.startsWith('172.25.250.'),
    };
  }

  // ── firewalld ────────────────────────────────────────────────────────────

  _fwZone(zone, permanent) {
    const name = zone || this.firewall.defaultZone;
    if (!FIREWALL_ZONES.includes(name)) return null;
    const scope = permanent ? this.firewall.permanent : this.firewall.runtime;
    if (!scope[name]) {
      const defaults =
        name === 'public' || name === 'work' || name === 'home' || name === 'internal'
          ? ['ssh', 'dhcpv6-client']
          : [];
      scope[name] = { services: new Set(defaults), ports: new Set() };
    }
    return scope[name];
  }

  firewallZoneInfo(zone, { permanent = false } = {}) {
    const entry = this._fwZone(zone, permanent);
    if (!entry) return null;
    return {
      name: zone || this.firewall.defaultZone,
      services: [...entry.services].sort(),
      ports: [...entry.ports].sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10)),
      interfaces:
        !permanent && (zone || this.firewall.defaultZone) === this.firewall.defaultZone
          ? ['eth0']
          : [],
      active: !permanent && (zone || this.firewall.defaultZone) === this.firewall.defaultZone,
    };
  }

  /** `--add-service`/`--add-port`/`--remove-*`: `{ok, warning?}` or `{error, code}`. */
  firewallChange(action, kind, value, { zone, permanent = false } = {}) {
    if (!this.firewall.running && !permanent)
      return { error: 'FirewallD is not running', code: 252 };
    const entry = this._fwZone(zone, permanent);
    if (!entry) return { error: `INVALID_ZONE: ${zone}`, code: 112 };
    const zoneName = zone || this.firewall.defaultZone;
    if (kind === 'service') {
      if (!FIREWALL_SERVICES[value])
        return { error: `INVALID_SERVICE: '${value}' not among existing services`, code: 101 };
      if (action === 'add') {
        if (entry.services.has(value))
          return { ok: true, warning: `ALREADY_ENABLED: '${value}' already in '${zoneName}'` };
        entry.services.add(value);
      } else {
        if (!entry.services.has(value))
          return { ok: true, warning: `NOT_ENABLED: '${value}' not in '${zoneName}'` };
        entry.services.delete(value);
      }
    } else {
      const port = String(value);
      const match = port.match(/^(\d+)(?:-(\d+))?\/(tcp|udp|sctp|dccp)$/);
      if (!match) {
        if (/^\d+(-\d+)?$/.test(port))
          return {
            error: `INVALID_PORT: bad port (most likely missing protocol), correct syntax is portid[-portid]/protocol`,
            code: 102,
          };
        if (/^\d+(-\d+)?\/\w+$/.test(port))
          return {
            error: `INVALID_PROTOCOL: '${port.split('/')[1]}' not from {'tcp'|'udp'|'sctp'|'dccp'}`,
            code: 103,
          };
        return { error: `INVALID_PORT: '${port.split('/')[0]}'`, code: 102 };
      }
      if (Number(match[1]) > 65535 || (match[2] && Number(match[2]) > 65535))
        return { error: `INVALID_PORT: '${port.split('/')[0]}'`, code: 102 };
      if (action === 'add') {
        if (entry.ports.has(port))
          return { ok: true, warning: `ALREADY_ENABLED: '${port}' already in '${zoneName}'` };
        entry.ports.add(port);
      } else {
        if (!entry.ports.has(port))
          return { ok: true, warning: `NOT_ENABLED: '${port}' not in '${zoneName}'` };
        entry.ports.delete(port);
      }
    }
    if (permanent) this._writeZoneFile(zoneName);
    return { ok: true };
  }

  firewallQuery(kind, value, { zone, permanent = false } = {}) {
    const entry = this._fwZone(zone, permanent);
    if (!entry) return false;
    return kind === 'service' ? entry.services.has(value) : entry.ports.has(String(value));
  }

  firewallReload() {
    if (!this.firewall.running) return { error: 'FirewallD is not running', code: 252 };
    const runtime = {};
    for (const [zone, entry] of Object.entries(this.firewall.permanent)) {
      runtime[zone] = { services: new Set(entry.services), ports: new Set(entry.ports) };
    }
    this.firewall.runtime = runtime;
    return { ok: true };
  }

  firewallRuntimeToPermanent() {
    const permanent = {};
    for (const [zone, entry] of Object.entries(this.firewall.runtime)) {
      permanent[zone] = { services: new Set(entry.services), ports: new Set(entry.ports) };
      this.firewall.permanent = permanent;
      this._writeZoneFile(zone);
    }
    this.firewall.permanent = permanent;
    return { ok: true };
  }

  _writeZoneFile(zone) {
    const entry = this.firewall.permanent[zone];
    if (!entry) return;
    this._mk(`/etc/firewalld/zones/${zone}.xml`, {
      content: this._zoneXml(zone, [...entry.services], [...entry.ports]),
      mode: 0o644,
      mtime: this.now(),
    });
    const backup = `/etc/firewalld/zones/${zone}.xml.old`;
    if (!this.nodes.has(backup))
      this._mk(backup, {
        content: this._zoneXml(zone, DEFAULT_FIREWALL_SERVICES, []),
        mode: 0o644,
        mtime: this.now(),
      });
  }

  get firewallZones() {
    return [...FIREWALL_ZONES];
  }

  // ── SELinux ──────────────────────────────────────────────────────────────

  setEnforce(mode) {
    if (this.selinux.mode === 'disabled') return { error: 'disabled' };
    this.selinux.mode =
      mode === 'enforcing' || mode === '1' || mode === 1 ? 'enforcing' : 'permissive';
    return { ok: true };
  }

  /** Mode written in /etc/selinux/config (what the next boot uses). */
  selinuxConfigMode() {
    const read = this.readFile('/etc/selinux/config', { user: 'root' });
    const match = read.ok ? read.content.match(/^SELINUX=(\w+)/m) : null;
    return match ? match[1] : 'enforcing';
  }

  portType(proto, port) {
    for (const [type, entry] of Object.entries(this.selinux.ports)) {
      if ((entry[proto] || []).includes(Number(port))) return type;
    }
    const number = Number(port);
    if (number < 512) return 'reserved_port_t';
    if (number < 1024) return 'hi_reserved_port_t';
    if (number >= 32768 && number <= 60999) return 'ephemeral_port_t';
    return 'unreserved_port_t';
  }

  portAllowedFor(domain, proto, port) {
    const type = this.portType(proto, port);
    if (domain === 'httpd_t') return type === 'http_port_t' || type === 'http_cache_port_t';
    return true;
  }

  /** `semanage port -a -t TYPE -p PROTO PORT`. */
  addPortLabel(type, proto, port) {
    const current = this.portType(proto, port);
    const defined = Object.entries(this.selinux.ports).some(([, entry]) =>
      (entry[proto] || []).includes(Number(port))
    );
    if (defined) return { error: `ValueError: Port ${proto}/${port} already defined` };
    if (!this.selinux.ports[type]) this.selinux.ports[type] = {};
    this.selinux.ports[type][proto] = [...(this.selinux.ports[type][proto] || []), Number(port)];
    this.selinux.localPorts = this.selinux.localPorts || [];
    this.selinux.localPorts.push({ type, proto, port: Number(port) });
    void current;
    return { ok: true };
  }

  deletePortLabel(proto, port) {
    const local = (this.selinux.localPorts || []).find(
      (entry) => entry.proto === proto && entry.port === Number(port)
    );
    if (!local)
      return { error: `ValueError: Port ${proto}/${port} is defined in policy, cannot be deleted` };
    this.selinux.localPorts = this.selinux.localPorts.filter((entry) => entry !== local);
    const list = this.selinux.ports[local.type]?.[proto] || [];
    this.selinux.ports[local.type][proto] = list.filter((value) => value !== Number(port));
    return { ok: true };
  }

  /** `semanage fcontext -a -t TYPE 'REGEX'`. */
  addFcontext(type, pattern) {
    let regex;
    try {
      regex = new RegExp(`^${pattern}$`);
    } catch {
      return { error: `ValueError: Invalid file specification ${pattern}` };
    }
    if (this.selinux.fcontext.some((rule) => rule.pattern === pattern)) {
      return { error: `ValueError: File context for ${pattern} already defined` };
    }
    this.selinux.fcontext.unshift({ pattern, type, regex });
    return { ok: true };
  }

  /** restorecon: reset the TYPE of path(s) to the policy default. Returns relabels. */
  restorecon(input, { recursive = false, cwd, user } = {}) {
    this.sync();
    const found = this.stat(input, { cwd, user, follow: false });
    if (!found.ok) return { error: found.error, path: found.path };
    const changes = [];
    const visit = (path, node) => {
      const current = String(node.context || '');
      const parts = current.split(':');
      const wanted = this.defaultContextType(path);
      if (parts.length >= 4 && parts[2] !== wanted) {
        const next = [parts[0], parts[1], wanted, parts.slice(3).join(':')].join(':');
        const meta = this._metaNode(path, node);
        meta.context = next;
        changes.push({ path, from: current, to: next });
      }
      if (recursive && node.type === 'dir') {
        for (const name of this._childNames(path)) {
          const childPath = `${path === '/' ? '' : path}/${name}`;
          const child = this._lookup(childPath);
          if (child) visit(childPath, child);
        }
      }
    };
    visit(found.path, found.node);
    return { ok: true, changes };
  }

  /** chcon -t TYPE / chcon CONTEXT. */
  chcon(input, { type, context, recursive = false, cwd, user } = {}) {
    this.sync();
    const found = this.stat(input, { cwd, user });
    if (!found.ok) return { error: found.error, path: found.path };
    const ident = this._ident(user);
    if (ident.uid !== 0 && found.node.uid !== ident.uid)
      return { error: 'EPERM', path: found.path };
    const apply = (path, node) => {
      const meta = this._metaNode(path, node);
      if (context) meta.context = context;
      else if (type) {
        const parts = String(meta.context || 'system_u:object_r:default_t:s0').split(':');
        parts[2] = type;
        meta.context = parts.join(':');
      }
      if (recursive && node.type === 'dir') {
        for (const name of this._childNames(path)) {
          const childPath = `${path === '/' ? '' : path}/${name}`;
          const child = this._lookup(childPath);
          if (child) apply(childPath, child);
        }
      }
    };
    apply(found.path, found.node);
    return { ok: true };
  }

  _recordDenial(denial) {
    const time = this.now();
    const record = {
      time,
      serial: 400 + this.selinux.denials.length * 7,
      pid: denial.pid || this._allocPid(),
      ino: denial.ino || 100000 + (fnv1a(denial.name || denial.tcontext) % 900000),
      ...denial,
    };
    this.selinux.denials.push(record);
    this._journalAppend({
      time,
      ident: 'setroubleshoot',
      pid: 4012,
      message: `SELinux is preventing ${denial.comm === 'httpd' ? '/usr/sbin/httpd' : denial.comm} from ${denial.perm} access on the ${denial.tclass === 'tcp_socket' ? `tcp_socket port ${denial.src}` : `file ${denial.path || denial.name}`}. For complete SELinux messages run: sealert -l ${fakeSha256(`${denial.name}-${time}`).slice(0, 8)}-${fakeSha256('a').slice(0, 4)}-4b1d-9c2e-${fakeSha256(denial.name || 'x').slice(0, 12)}`,
      priority: 3,
    });
    return record;
  }

  // ── local HTTP servers (httpd/nginx units, published container ports) ───

  /**
   * Serve a request that reached this workstation (`curl http://localhost…`).
   * @returns {{status: number, statusText: string, headers: object, body: string, server: string}|{error: {code: number, message: string}}}
   */
  serveLocalHttp({ host, port, path = '/', method = 'GET', scheme = 'http' }) {
    this.sync();
    const socket = this.listeningSockets().find(
      (entry) => entry.proto === 'tcp' && entry.port === Number(port)
    );
    if (!socket) {
      return {
        error: {
          code: 7,
          message: `Failed to connect to ${host} port ${port}: Connection refused`,
        },
      };
    }
    if (socket.container) return this._serveContainerHttp(socket.container, { path, method });
    const unit = this.units.get(socket.owner);
    if (unit?.def?.validator === 'httpd' || unit?.short === 'nginx') {
      if (scheme === 'https')
        return {
          error: { code: 35, message: 'error:0A00010B:SSL routines::wrong version number' },
        };
      return this._serveHttpd(unit, { path, method });
    }
    if (unit?.short === 'sshd') {
      return { error: { code: 1, message: 'Received HTTP/0.9 when not allowed' } };
    }
    return { error: { code: 52, message: 'Empty reply from server' } };
  }

  _httpResponse(server, status, body, extra = {}) {
    const statusText =
      {
        200: 'OK',
        301: 'Moved Permanently',
        403: 'Forbidden',
        404: 'Not Found',
        500: 'Internal Server Error',
      }[status] || 'OK';
    const date = new Date(this.now()).toUTCString();
    const headers =
      server === 'nginx'
        ? {
            Server: 'nginx/1.20.1',
            Date: date,
            'Content-Type': 'text/html',
            'Content-Length': String(byteLength(body)),
            Connection: 'keep-alive',
          }
        : {
            Date: date,
            Server: 'Apache/2.4.62 (Red Hat Enterprise Linux)',
            ...(status === 200
              ? {
                  'Last-Modified': new Date(extra.mtime || this.now()).toUTCString(),
                  ETag: `"${byteLength(body).toString(16)}-${fakeSha256(body).slice(0, 13)}"`,
                  'Accept-Ranges': 'bytes',
                }
              : {}),
            'Content-Length': String(byteLength(body)),
            'Content-Type': extra.contentType || 'text/html; charset=UTF-8',
          };
    return { status, statusText, headers, body, server };
  }

  _serveHttpd(unit, { path, method }) {
    const server = unit.short === 'nginx' ? 'nginx' : 'httpd';
    const docRoot = server === 'nginx' ? '/usr/share/nginx/html' : this.httpdDocumentRoot();
    const apache =
      this.identity(server === 'nginx' ? 'nginx' : 'apache') || this.identity('nobody');
    const record = (status, bytes) => {
      this.httpLog.push({ server, client: '::1', time: this.now(), method, path, status, bytes });
      return null;
    };
    const cleanPath = decodeURIComponent(String(path || '/').split('?')[0]);
    let target = normalizePath(`${docRoot}/${cleanPath}`);
    let walked = this._walk(target, apache, true);
    const notFound = () => {
      const body =
        '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n<title>404 Not Found</title>\n</head><body>\n<h1>Not Found</h1>\n<p>The requested URL was not found on this server.</p>\n</body></html>\n';
      record(404, byteLength(body));
      return this._httpResponse(server, 404, body);
    };
    const forbidden = () => {
      const body =
        '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n<title>403 Forbidden</title>\n</head><body>\n<h1>Forbidden</h1>\n<p>You don\'t have permission to access this resource.</p>\n</body></html>\n';
      record(403, byteLength(body));
      return this._httpResponse(server, 403, body);
    };
    if (walked.error === 'EACCES') return forbidden();
    if (walked.error || !walked.node) return notFound();
    if (walked.node.type === 'dir') {
      target = normalizePath(`${walked.path}/index.html`);
      walked = this._walk(target, apache, true);
      if (walked.error === 'EACCES') return forbidden();
      if (walked.error || !walked.node) {
        if (cleanPath === '/' || cleanPath === '') {
          // welcome.conf: the RHEL test page is the 403 ErrorDocument of an empty DocumentRoot.
          record(403, byteLength(HTTPD_TEST_PAGE));
          return this._httpResponse(server, 403, HTTPD_TEST_PAGE);
        }
        return forbidden();
      }
    }
    const node = walked.node;
    if (!this._can(node, apache, 4)) {
      return forbidden();
    }
    const type = String(node.context || '').split(':')[2];
    if (this.selinux.mode !== 'disabled' && !HTTPD_READABLE_TYPES.has(type)) {
      this._recordDenial({
        perm: 'read',
        comm: 'httpd',
        name: basenameOf(walked.path),
        path: walked.path,
        tclass: 'file',
        scontext: 'system_u:system_r:httpd_t:s0',
        tcontext: node.context,
      });
      if (this.selinux.mode === 'enforcing') return forbidden();
    }
    const body = this._content(walked.path, node);
    record(200, byteLength(body));
    return this._httpResponse(server, 200, body, {
      mtime: node.mtime,
      contentType: /\.html?$/.test(walked.path)
        ? 'text/html; charset=UTF-8'
        : 'text/plain; charset=UTF-8',
    });
  }

  _httpdErrorLog() {
    const lines = [];
    for (const denial of this.selinux.denials) {
      if (denial.comm !== 'httpd' || denial.tclass !== 'file') continue;
      lines.push(
        `[${this._apacheErrorTime(denial.time)}] [core:error] [pid ${denial.pid}:tid ${denial.pid + 3}] (13)Permission denied: [client ::1:45126] AH00035: access to /${denial.name} denied (filesystem path '${denial.path}') because search permissions are missing on a component of the path`
      );
    }
    return lines.length ? `${lines.join('\n')}\n` : '';
  }

  _apacheErrorTime(ms) {
    const parts = clockParts(ms);
    return `${DAYS[parts.weekday]} ${MONTHS[parts.month]} ${pad2(parts.day)} ${pad2(parts.hours)}:${pad2(parts.minutes)}:${pad2(parts.seconds)}.${String(parts.millis).padStart(3, '0')}${String(fnv1a(ms) % 1000).padStart(3, '0')} ${parts.year}`;
  }

  // ── rootless podman ──────────────────────────────────────────────────────

  _emptyPodmanStore() {
    return { images: new Map(), containers: new Map() };
  }

  _buildRegistry() {
    for (const def of IMAGE_DEFS) this._addRegistryImage(def);
  }

  _addRegistryImage(def) {
    const repo = String(def.repo || def.ref || '').replace(/:[^/]*$/, '');
    if (!repo) return null;
    const tags = def.tags?.length ? [...def.tags] : ['latest'];
    const entry = {
      repo,
      tags,
      digest: imageDigest(`${repo}:${tags.includes('latest') ? 'latest' : tags[0]}`),
      id: fakeSha256(`image-id:${repo}`),
      sizeMB: Number(def.size ?? 80),
      created: def.created || new Date(this.installTime).toISOString(),
      cmd: def.cmd ? [...def.cmd] : ['/bin/bash'],
      entrypoint: def.entrypoint ? [...def.entrypoint] : [],
      user: String(def.user ?? '0'),
      workdir: def.workdir || '/',
      exposes: (def.exposes || []).map(Number),
      labels: { ...(def.labels || {}) },
      env: [
        ...(def.env || []),
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'container=oci',
      ],
      summary: def.summary || '',
      serves: def.serves || null,
      body: def.body ?? null,
      comm: def.comm || null,
      requiresEnv: def.requiresEnv ? [...def.requiresEnv] : [],
    };
    this.registry.set(repo, entry);
    return entry;
  }

  /**
   * Resolve a typed image reference: full names, RHEL short-name aliases
   * (`ubi9/httpd-24` → registry.access.redhat.com/ubi9/httpd-24) and `:tag`/`@digest`.
   * @returns {{repo, tag, ref, entry, alias}|{error, …}}
   */
  resolveImageRef(input) {
    let text = String(input || '')
      .trim()
      .replace(/^docker:\/\//, '');
    if (!text) return { error: 'empty' };
    let digest = null;
    if (text.includes('@')) {
      [text, digest] = text.split('@');
    }
    let tag = 'latest';
    const lastSlash = text.lastIndexOf('/');
    const colon = text.lastIndexOf(':');
    if (colon > lastSlash) {
      tag = text.slice(colon + 1);
      text = text.slice(0, colon);
    }
    const first = text.split('/')[0];
    const qualified =
      text.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
    let repo = text;
    let alias = false;
    if (!qualified) {
      const candidates = [
        `registry.access.redhat.com/${text}`,
        `registry.redhat.io/${text}`,
        `quay.io/${text}`,
      ];
      const hit = candidates.find((candidate) => this.registry.has(candidate));
      if (!hit) return { error: 'short-name', name: input };
      repo = hit;
      alias = true;
    }
    const entry = this.registry.get(repo) || null;
    return {
      repo,
      tag,
      digest,
      ref: `${repo}:${tag}`,
      entry,
      alias,
      registryHost: repo.split('/')[0],
    };
  }

  _podmanStore(user) {
    const name = user === 'root' ? 'root' : 'student';
    return this.podman[name];
  }

  /** Local image by reference, short id or `repo:tag`. */
  findImage(input, { user } = {}) {
    const store = this._podmanStore(user ?? this.session.user);
    const text = String(input || '').trim();
    for (const image of store.images.values()) {
      if (image.id.startsWith(text) && text.length >= 3) return image;
      if (image.names.includes(text) || image.names.includes(`${text}:latest`)) return image;
    }
    const resolved = this.resolveImageRef(text);
    if (resolved.error) {
      for (const image of store.images.values()) {
        if (
          image.names.some(
            (name) => name === `localhost/${text}` || name === `localhost/${text}:latest`
          )
        )
          return image;
      }
      return null;
    }
    for (const image of store.images.values()) if (image.names.includes(resolved.ref)) return image;
    return null;
  }

  /** `podman pull`: `{ok, image, resolved, existed}` or `{error, resolved}`. */
  pullImage(input, { user } = {}) {
    const resolved = this.resolveImageRef(input);
    if (resolved.error) return resolved;
    if (!resolved.entry) {
      if (
        !this.dnsLookup(resolved.registryHost) &&
        !['registry.access.redhat.com', 'registry.redhat.io', 'quay.io'].includes(
          resolved.registryHost
        )
      ) {
        return { error: 'no-such-host', resolved };
      }
      return { error: 'repo-not-found', resolved };
    }
    if (!resolved.entry.tags.includes(resolved.tag)) return { error: 'manifest-unknown', resolved };
    const store = this._podmanStore(user ?? this.session.user);
    const entry = resolved.entry;
    let image = store.images.get(entry.id);
    const existed = Boolean(image);
    if (!image) {
      image = {
        id: entry.id,
        repo: entry.repo,
        digest: entry.digest,
        names: [],
        created: entry.created,
        pulledAt: this.now(),
        entry,
      };
      store.images.set(entry.id, image);
    }
    if (!image.names.includes(resolved.ref)) image.names.push(resolved.ref);
    return { ok: true, image, resolved, existed };
  }

  /** Remove a local image (`podman rmi`). */
  removeImage(input, { user, force = false } = {}) {
    const store = this._podmanStore(user ?? this.session.user);
    const image = this.findImage(input, { user });
    if (!image) return { error: 'not-found' };
    const users = [...store.containers.values()].filter(
      (container) => container.imageId === image.id
    );
    if (users.length && !force) return { error: 'in-use', container: users[0] };
    for (const container of users) this.removeContainer(container.id, { user, force: true });
    const untagged = [...image.names];
    store.images.delete(image.id);
    return { ok: true, image, untagged };
  }

  tagImage(source, target, { user } = {}) {
    const image = this.findImage(source, { user });
    if (!image) return { error: 'not-found' };
    let name = String(target);
    const lastSlash = name.lastIndexOf('/');
    if (name.lastIndexOf(':') <= lastSlash) name = `${name}:latest`;
    const first = name.split('/')[0];
    if (
      !name.includes('/') ||
      !(first.includes('.') || first.includes(':') || first === 'localhost')
    )
      name = `localhost/${name}`;
    if (!image.names.includes(name)) image.names.push(name);
    return { ok: true, image, name };
  }

  findContainer(input, { user } = {}) {
    const store = this._podmanStore(user ?? this.session.user);
    const text = String(input || '').trim();
    if (!text) return null;
    for (const container of store.containers.values())
      if (container.name === text) return container;
    for (const container of store.containers.values())
      if (container.id.startsWith(text) && text.length >= 3) return container;
    return null;
  }

  listContainers({ user, all = false } = {}) {
    const store = this._podmanStore(user ?? this.session.user);
    return [...store.containers.values()]
      .filter((container) => all || container.state === 'running')
      .sort((a, b) => b.created - a.created);
  }

  /**
   * `podman create/run`. Returns `{ok, container}` or `{error, …}`. Publishing follows
   * rootless rules (ports < 1024 refused by pasta) and port conflicts.
   */
  createContainer(spec = {}, { user } = {}) {
    const owner = user ?? this.session.user;
    const store = this._podmanStore(owner);
    const image = spec.image;
    const name = spec.name || this._randomContainerName();
    const existing = this.findContainer(name, { user: owner });
    if (existing && spec.name) return { error: 'name-in-use', container: existing };
    const ports = [];
    for (const publish of spec.ports || []) {
      const parsed = parsePublish(publish);
      if (!parsed) return { error: 'bad-publish', value: publish };
      ports.push(parsed);
    }
    const id = fakeSha256(
      `container:${name}:${this.now()}:${store.containers.size}:${this.generation}`
    );
    const entry = image.entry;
    const container = {
      id,
      name,
      imageId: image.id,
      imageRef: spec.imageRef || image.names[0],
      image,
      created: this.now(),
      startedAt: null,
      finishedAt: null,
      state: 'created',
      exitCode: 0,
      ports,
      env: { ...(spec.env || {}) },
      command: spec.command?.length
        ? [...spec.command]
        : [...(entry.entrypoint || []), ...(entry.cmd || [])],
      customCommand: Boolean(spec.command?.length),
      user: owner === 'root' ? 'root' : 'student',
      logs: [],
      files: new Map(),
      volumes: [...(spec.volumes || [])],
      rm: Boolean(spec.rm),
      hostname: id.slice(0, 12),
      pids: [],
    };
    store.containers.set(id, container);
    return { ok: true, container };
  }

  _randomContainerName() {
    const adjectives = [
      'admiring',
      'bold',
      'eager',
      'focused',
      'gifted',
      'happy',
      'jolly',
      'keen',
      'nice',
      'quirky',
      'sharp',
      'stoic',
    ];
    const names = [
      'archimedes',
      'babbage',
      'curie',
      'darwin',
      'euler',
      'feynman',
      'galileo',
      'hopper',
      'lovelace',
      'noether',
      'tesla',
      'turing',
    ];
    const seed = fnv1a(`${this.now()}-${this.generation}-${this.nextPid}`);
    return `${adjectives[seed % adjectives.length]}_${names[(seed >>> 8) % names.length]}`;
  }

  /** Port conflicts / rootless privileged ports for a container about to start. */
  _publishError(container) {
    for (const port of container.ports) {
      if (container.user !== 'root' && port.hostPort < 1024) {
        return { error: 'privileged-port', port };
      }
      const holder = this.listeningSockets().find(
        (socket) =>
          socket.proto === port.proto &&
          socket.port === port.hostPort &&
          socket.owner !== `container:${container.id}`
      );
      if (holder) return { error: 'port-in-use', port };
    }
    return null;
  }

  startContainer(container) {
    if (container.state === 'running') return { ok: true, already: true };
    const publishError = this._publishError(container);
    if (publishError) return publishError;
    const entry = container.image.entry;
    const now = this.now();
    container.startedAt = now;
    container.finishedAt = null;
    const missingEnv = (entry.requiresEnv || []).filter((key) => !container.env[key]);
    const command = container.command.join(' ');
    const isShell =
      /^(\/bin\/)?(ba)?sh$/.test(container.command[0] || '') && container.command.length === 1;
    if (missingEnv.length && !container.customCommand) {
      container.logs.push(
        'You must either specify the following environment variables:',
        "  MYSQL_USER (regex: '^[a-zA-Z0-9_]+$')",
        "  MYSQL_PASSWORD (regex: '^[a-zA-Z0-9_~!@#$%^&*()-=<>,.?;:|]+$')",
        "  MYSQL_DATABASE (regex: '^[a-zA-Z0-9_]+$')",
        'Or the following environment variable:',
        "  MYSQL_ROOT_PASSWORD (regex: '^[a-zA-Z0-9_~!@#$%^&*()-=<>,.?;:|]+$')",
        'Or both.',
        'Optional Settings:',
        '  MYSQL_LOWER_CASE_TABLE_NAMES (default: 0)',
        '  MYSQL_LOG_QUERIES_ENABLED (default: 0)',
        '  MYSQL_MAX_CONNECTIONS (default: 151)',
        '',
        'For more information, see https://github.com/sclorg/mariadb-container'
      );
      container.state = 'exited';
      container.exitCode = 1;
      container.finishedAt = now + 300;
      return { ok: true, exited: true };
    }
    if (isShell && !container.interactive) {
      container.state = 'exited';
      container.exitCode = 0;
      container.finishedAt = now + 120;
      return { ok: true, exited: true };
    }
    container.state = 'running';
    container.exitCode = 0;
    const hostUid = (uid) => (Number(uid) === 0 ? 'student' : String(100000 + Number(uid) - 1));
    const processUser = container.user === 'root' ? 'root' : hostUid(entry.user);
    const conmon = this._spawnProcess({
      ppid: 1460,
      user: container.user,
      comm: 'conmon',
      args: `/usr/bin/conmon --api-version 1 -c ${container.id} -u ${container.id} -r /usr/bin/crun -b /home/student/.local/share/containers/storage/overlay-containers/${container.id}/userdata -p /run/user/1000/containers/overlay-containers/${container.id}/userdata/pidfile -n ${container.name} --exit-dir /run/user/1000/libpod/tmp/exits`,
      rss: 2304,
      vsz: 76972,
      container: container.id,
      label: 'unconfined_u:unconfined_r:container_runtime_t:s0-s0:c0.c1023',
    });
    const main = this._spawnProcess({
      ppid: conmon.pid,
      user: processUser,
      comm: entry.comm || basenameOf(container.command[0] || 'sh'),
      args: command || '/bin/sh',
      rss: 12000,
      vsz: 420000,
      container: container.id,
      label: `system_u:system_r:container_t:s0:c${(fnv1a(container.id) % 900) + 100},c${(fnv1a(container.name) % 900) + 100}`,
    });
    container.pid = main.pid;
    container.pids = [conmon.pid, main.pid];
    if (container.ports.length) {
      const pasta = this._spawnProcess({
        ppid: 1,
        user: container.user,
        comm: 'pasta.avx2',
        args: `/usr/bin/pasta --config-net -t ${container.ports.map((port) => `${port.hostPort}-${port.hostPort}:${port.containerPort}-${port.containerPort}`).join(',')} --dns-forward 169.254.1.1 -u none -T none -U none --no-map-gw --quiet --netns /run/user/1000/netns/netns-${container.id.slice(0, 8)}`,
        rss: 3800,
        vsz: 67000,
        container: container.id,
        label: 'unconfined_u:unconfined_r:container_runtime_t:s0-s0:c0.c1023',
      });
      container.netPid = pasta.pid;
      container.pids.push(pasta.pid);
    }
    const stamp = this._apacheErrorTime(now);
    if (entry.serves === 'httpd')
      container.logs.push(...CONTAINER_HTTPD_LOGS(WORKSTATION_IP, stamp));
    else if (entry.serves === 'hello') container.logs.push('serving on 8888', 'serving on 8080');
    else if (entry.serves === 'nginx')
      container.logs.push(
        `${new Date(now).toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, '/')} [notice] 1#1: using the "epoll" event method`,
        `${new Date(now).toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, '/')} [notice] 1#1: start worker processes`
      );
    return { ok: true };
  }

  /** Stop: SIGTERM, then SIGKILL after 10 s for processes that ignore it (sleep as PID 1). */
  stopContainer(container, { timeout = 10 } = {}) {
    if (container.state !== 'running') return { ok: true, already: true };
    const ignoresTerm =
      /^(\/usr\/bin\/)?sleep\b/.test(container.command.join(' ')) ||
      /^(\/bin\/)?(ba)?sh\b/.test(container.command.join(' '));
    for (const pid of container.pids) this.processes.delete(pid);
    container.pids = [];
    container.pid = null;
    container.netPid = null;
    container.state = 'exited';
    container.exitCode = ignoresTerm ? 137 : 0;
    container.finishedAt = this.now();
    return { ok: true, killed: ignoresTerm, timeout };
  }

  removeContainer(input, { user, force = false } = {}) {
    const store = this._podmanStore(user ?? this.session.user);
    const container = typeof input === 'object' ? input : this.findContainer(input, { user });
    if (!container) return { error: 'not-found' };
    if (container.state === 'running' && !force) return { error: 'running', container };
    if (container.state === 'running') this.stopContainer(container, { timeout: 0 });
    store.containers.delete(container.id);
    return { ok: true, container };
  }

  _containerProcessDied(process) {
    for (const store of Object.values(this.podman)) {
      const container = store.containers.get(process.container);
      if (!container || container.pid !== process.pid) continue;
      for (const pid of container.pids) this.processes.delete(pid);
      container.state = 'exited';
      container.exitCode = 137;
      container.finishedAt = this.now();
      container.pids = [];
      container.pid = null;
    }
  }

  /** Content of a file inside a container (image defaults + writes). */
  containerFile(container, path) {
    const abs = normalizePath(path);
    if (container.files.has(abs)) return container.files.get(abs);
    const entry = container.image.entry;
    const files = {
      '/etc/redhat-release': `Red Hat Enterprise Linux release ${RHEL_VERSION} (Plow)\n`,
      '/etc/os-release': UBI_OS_RELEASE,
      '/etc/hostname': `${container.hostname}\n`,
      '/etc/hosts': `127.0.0.1\tlocalhost localhost.localdomain localhost4 localhost4.localdomain4\n::1\tlocalhost localhost.localdomain localhost6 localhost6.localdomain6\n${WORKSTATION_IP}\t${container.hostname} ${container.name}\n169.254.1.2\thost.containers.internal host.docker.internal\n`,
      '/etc/resolv.conf': `search lab.example.com\nnameserver 169.254.1.1\n`,
    };
    if (entry.serves === 'httpd') {
      files['/etc/httpd/conf/httpd.conf'] = HTTPD_CONF.replace('Listen 80', 'Listen 0.0.0.0:8080')
        .replace('User apache', 'User default')
        .replace('Group apache', 'Group root');
    }
    return files[abs] ?? null;
  }

  containerDirectory(container, path) {
    const abs = normalizePath(path);
    const entry = container.image.entry;
    const base = {
      '/': [
        'afs',
        'bin',
        'boot',
        'dev',
        'etc',
        'home',
        'lib',
        'lib64',
        'media',
        'mnt',
        'opt',
        'proc',
        'root',
        'run',
        'sbin',
        'srv',
        'sys',
        'tmp',
        'usr',
        'var',
      ],
      '/etc': ['hostname', 'hosts', 'os-release', 'redhat-release', 'resolv.conf'],
      '/var/www': entry.serves === 'httpd' ? ['cgi-bin', 'html'] : null,
      '/var/www/html':
        entry.serves === 'httpd'
          ? [...container.files.keys()]
              .filter((key) => key.startsWith('/var/www/html/'))
              .map((key) => key.slice(14))
          : null,
      '/opt/app-root/src': entry.serves ? [] : null,
      '/tmp': [],
    };
    return base[abs] ?? null;
  }

  /** HTTP answer of a running container's published port. */
  _serveContainerHttp(container, { path = '/' } = {}) {
    const entry = container.image.entry;
    if (entry.serves === 'hello')
      return this._httpResponse('hello', 200, 'Hello OpenShift!\n', {
        contentType: 'text/plain; charset=utf-8',
      });
    if (entry.serves === 'httpd' || entry.serves === 'nginx') {
      const page = container.files.get(`/var/www/html${path === '/' ? '/index.html' : path}`);
      if (page !== undefined) return this._httpResponse(entry.serves, 200, page);
      if (path === '/' || path === '/index.html')
        return this._httpResponse(
          entry.serves,
          entry.serves === 'nginx' ? 200 : 403,
          HTTPD_TEST_PAGE
        );
      return this._httpResponse(
        entry.serves,
        404,
        '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n<title>404 Not Found</title>\n</head><body>\n<h1>Not Found</h1>\n<p>The requested URL was not found on this server.</p>\n</body></html>\n'
      );
    }
    if (entry.body)
      return this._httpResponse('app', 200, entry.body, {
        contentType: 'text/plain; charset=utf-8',
      });
    return { error: { code: 56, message: 'Recv failure: Connection reset by peer' } };
  }

  // ── seeds (levelDef.linuxHost) ───────────────────────────────────────────

  /** Apply a level seed on top of the default machine (see LINUX-SCHEMA.md). */
  applySeed(seed) {
    const s = seed || {};
    if (s.hostname) this.hostname = String(s.hostname);
    if (s.selinux) {
      const mode = String(s.selinux);
      this.selinux.mode =
        mode === 'disabled' ? 'disabled' : mode === 'permissive' ? 'permissive' : 'enforcing';
    }
    for (const group of s.groups || []) this.addGroup(group);
    for (const user of s.users || []) this.addUser(user);
    for (const group of s.groups || []) {
      const entry = this.groups.get(group.name);
      for (const member of group.members || []) entry?.members.add(member);
    }
    if (s.packages) {
      for (const pkg of s.packages.catalog || []) this._addCatalogPackage(pkg);
      if (s.packages.install?.length) {
        this.installPackages(s.packages.install, { reason: 'user' });
        for (const name of s.packages.install) {
          const installed = this.installed.get(name);
          if (installed) installed.time = this.resetAt - 3 * 3600 * 1000;
        }
      }
      if (s.packages.remove?.length) this.removePackages(s.packages.remove);
      this.dnfHistory = [];
    }
    for (const path of s.remove || []) {
      const abs = this.resolvePath(path, { cwd: HOME });
      // First launch: the Files store (and its default lab files) appears after the seed;
      // remember home/tmp removals and apply them when the store attaches.
      if (isVfsArea(abs) && abs !== HOME && abs !== '/tmp' && !this._store()) {
        this._deferredRemovals.push(abs);
        this._scheduleFlush();
      }
      const node = this._lookup(abs);
      if (!node) continue;
      if (node.type === 'dir') this.removeTree(abs, { user: 'root' });
      else this._deleteNode(abs, node);
    }
    for (const file of s.files || []) this._seedFile(file);
    for (const entry of s.hosts || []) {
      const read = this.readFile('/etc/hosts', { user: 'root' });
      const line = `${entry.ip}${' '.repeat(Math.max(1, 16 - String(entry.ip).length))}${(entry.names || [entry.name]).filter(Boolean).join(' ')}`;
      const node = this._lookup('/etc/hosts');
      if (node) this._setContent('/etc/hosts', node, `${read.content || ''}${line}\n`);
    }
    for (const [name, ip] of Object.entries(s.dns || {})) {
      if (name.startsWith('*.')) this.dnsWildcards.unshift([name.slice(2), ip]);
      else this.dns.set(name.toLowerCase(), ip);
      this.reachable.add(ip);
    }
    if (s.network?.unreachable) for (const ip of s.network.unreachable) this.reachable.delete(ip);
    if (s.firewall) this._seedFirewall(s.firewall);
    for (const service of s.services || []) this._seedService(service);
    for (const process of s.processes || []) {
      const ageMs = Number(process.ageMinutes ?? 18) * 60000;
      this._spawnProcess({
        pid: process.pid,
        ppid: process.ppid ?? (process.user === 'root' ? 1 : 2297),
        user: process.user || 'student',
        comm: process.name || basenameOf(String(process.command || 'process').split(/\s+/)[0]),
        args: process.command || process.name,
        cpu: process.cpu ?? 0,
        mem: process.mem,
        rss: process.rss ?? 1792,
        vsz: process.vsz ?? 220988,
        tty: process.tty || (process.user === 'root' ? '?' : 'pts/1'),
        stat: process.stat || (Number(process.cpu) >= 50 ? 'R' : 'S'),
        start: this.resetAt - ageMs,
        ignoreTerm: Boolean(process.ignoreTerm),
        nice: process.nice ?? 0,
        seeded: true,
      });
    }
    for (const entry of s.journal || []) {
      const unit = entry.unit ? this.unitName(entry.unit) : null;
      this._journalAppend({
        time: this.resetAt - Number(entry.minutesAgo ?? 5) * 60000,
        ident:
          entry.ident || (unit ? unit.replace(/\.service$/, '').replace(/d$/, 'd') : 'systemd'),
        pid: entry.pid ?? 4100 + this.journal.length,
        unit,
        priority:
          typeof entry.priority === 'number'
            ? entry.priority
            : ({
                emerg: 0,
                alert: 1,
                crit: 2,
                err: 3,
                error: 3,
                warning: 4,
                warn: 4,
                notice: 5,
                info: 6,
                debug: 7,
              }[entry.priority] ?? 6),
        message: entry.message,
        facility: entry.facility,
      });
    }
    if (s.podman) this._seedPodman(s.podman);
    if (s.user === 'root') {
      this.session.stack.push({ user: 'student', cwd: HOME, oldpwd: null });
      this.session.user = 'root';
      this.session.cwd = '/root';
    }
    if (s.cwd) {
      const abs = this.resolvePath(s.cwd, { cwd: HOME });
      if (this._lookup(abs)?.type === 'dir') this.session.cwd = abs;
    }
    this.journal.sort((a, b) => a.time - b.time || a.seq - b.seq);
    return this;
  }

  _seedFile(file) {
    if (!file || !file.path) return;
    const abs = this.resolvePath(file.path, { cwd: HOME });
    const inHome = isVfsArea(abs);
    const owner = file.owner ?? (inHome ? 'student' : 'root');
    const group =
      file.group ??
      (file.owner && this.users.has(file.owner)
        ? this.groupName(this.users.get(file.owner).gid)
        : inHome
          ? 'student'
          : 'root');
    const mtime =
      file.mtime ??
      (file.minutesAgo !== undefined
        ? this.resetAt - Number(file.minutesAgo) * 60000
        : this.resetAt - 2 * 3600 * 1000);
    const mode =
      file.mode !== undefined
        ? typeof file.mode === 'number'
          ? file.mode
          : Number.parseInt(String(file.mode), 8)
        : undefined;
    const seuser = inHome ? 'unconfined_u' : 'system_u';
    if (file.type === 'directory' || file.type === 'dir') {
      this._ensureParents(abs, inHome ? 'student' : undefined);
      this.nodes.set(abs, {
        type: 'dir',
        mode: mode ?? 0o755,
        uid: this._uidOf(owner),
        gid: this._gidOf(group),
        mtime,
        context: file.context || this.defaultContext(abs, seuser),
      });
      return;
    }
    if (file.type === 'symlink' || file.type === 'link' || file.target) {
      this._ensureParents(abs, inHome ? 'student' : undefined);
      this.nodes.set(abs, {
        type: 'link',
        target: String(file.target),
        mode: 0o777,
        uid: this._uidOf(owner),
        gid: this._gidOf(group),
        mtime,
        context: file.context || this.defaultContext(abs, seuser),
      });
      return;
    }
    this._ensureParents(abs, inHome ? 'student' : undefined);
    const existing = this._lookup(abs);
    if (existing && existing.type === 'file' && existing.generator) {
      this._acceptGenerated(existing.generator, abs, String(file.content ?? ''));
      return;
    }
    if (existing && existing.type === 'file') this._deleteNode(abs, existing);
    const fileMode = mode ?? (file.executable ? 0o755 : 0o644);
    // A home file the student may not read (L104's root-owned 0640 kubeconfig) stays out
    // of the Files panel, which reads the store without permission checks.
    const student = this.identity('student');
    const uid = this._uidOf(owner);
    const gid = this._gidOf(group);
    const studentCanRead =
      uid === student.uid
        ? Boolean(fileMode & 0o400)
        : student.gids.has(gid)
          ? Boolean(fileMode & 0o040)
          : Boolean(fileMode & 0o004);
    const hostOnly =
      Boolean(file.hostOnly) || (existing?.hostOnly && inHome) || (inHome && !studentCanRead);
    this._createFile(abs, String(file.content ?? ''), {
      uid,
      gid,
      mode: fileMode,
      context: file.context || this.defaultContext(abs, seuser),
      mtime,
      hostOnly,
    });
  }

  _seedFirewall(spec) {
    const zone = spec.zone || this.firewall.defaultZone;
    if (spec.running === false) this.firewall.running = false;
    const apply = (scope, entry) => {
      if (!entry) return;
      const target = this._fwZone(zone, scope === 'permanent');
      if (entry.services) target.services = new Set(entry.services);
      if (entry.ports) target.ports = new Set(entry.ports.map(String));
      if (scope === 'permanent') this._writeZoneFile(zone);
    };
    if (spec.services || spec.ports) {
      apply('runtime', { services: spec.services, ports: spec.ports });
      apply('permanent', { services: spec.services, ports: spec.ports });
    }
    apply('runtime', spec.runtime);
    apply('permanent', spec.permanent);
  }

  _seedService(spec) {
    if (!spec || !spec.name) return;
    const name = this.unitName(spec.name);
    const short = name.replace(/\.service$/, '');
    let unit = this.units.get(name);
    if (!unit) {
      const def = UNIT_DEFS[short]
        ? { ...UNIT_DEFS[short] }
        : {
            description: spec.description || `${short}.service`,
            exec: spec.execStart || `/usr/local/bin/${short}`,
            cmd: (spec.execStart || `/usr/local/bin/${short}`).replace(/^[-@+!:]+/, ''),
            comm: basenameOf(String(spec.execStart || short).split(/\s+/)[0]).slice(0, 15),
            type: spec.type || 'simple',
            user: spec.user || 'root',
            ports: (spec.ports || []).map((port) =>
              Array.isArray(port) ? port : ['tcp', Number(port), '*']
            ),
            restart: spec.restart || 'no',
            preset: 'disabled',
            label: 'unconfined_service_t',
          };
      unit = this._registerUnit(short, def, { custom: !UNIT_DEFS[short] });
    }
    if (Array.isArray(spec.failWhen)) unit.failWhen = spec.failWhen.map((hook) => ({ ...hook }));
    if (spec.restart) unit.def.restart = spec.restart;
    if (spec.enabled === true) this._setEnabled(unit, true, { quiet: true });
    if (spec.enabled === false) this._setEnabled(unit, false, { quiet: true });
    if (spec.enabled === 'masked') this.maskUnit(short);
    const at = this.resetAt - Number(spec.minutesAgo ?? (spec.failing ? 4 : 95)) * 60000;
    if (spec.failing) {
      if (unit.active === 'active') this._stopUnit(unit, { at: at - 60000, quiet: true });
      const result = this._startUnit(unit, { at });
      if (!result.error) {
        // No validator explains the failure: record a generic exit-code failure.
        this._stopUnit(unit, { at: at + 100, quiet: true });
        this._failUnitGeneric(unit, at + 120);
      }
    } else if (spec.active === true) {
      if (unit.active !== 'active') this._startUnit(unit, { at });
    } else if (spec.active === false) {
      if (unit.active === 'active') this._stopUnit(unit, { at, quiet: true });
      unit.active = 'inactive';
      unit.sub = 'dead';
      if (unit.short === 'chronyd') {
        this.timeSync.synced = false;
        this.timeSync.ntpEnabled = false;
      }
    }
  }

  _failUnitGeneric(unit, time) {
    const pid = this._allocPid();
    this._journalAppend({
      time,
      ident: 'systemd',
      pid: 1,
      unit: unit.name,
      message: `Starting ${unit.def.description}...`,
      priority: 6,
      catalog: { type: 'start-begin', unit: unit.name, job: this._allocJob() },
    });
    this._journalAppend({
      time: time + 25,
      ident: 'systemd',
      pid: 1,
      unit: unit.name,
      message: `${unit.name}: Main process exited, code=exited, status=1/FAILURE`,
      priority: 5,
      catalog: { type: 'process-exited', unit: unit.name, code: 'exited', status: 1 },
    });
    this._journalAppend({
      time: time + 26,
      ident: 'systemd',
      pid: 1,
      unit: unit.name,
      message: `${unit.name}: Failed with result 'exit-code'.`,
      priority: 4,
      catalog: { type: 'unit-failed', unit: unit.name, result: 'exit-code' },
    });
    this._journalAppend({
      time: time + 27,
      ident: 'systemd',
      pid: 1,
      unit: unit.name,
      message: `Failed to start ${unit.def.description}.`,
      priority: 3,
      catalog: { type: 'start-failed', unit: unit.name, job: this.nextJobId },
    });
    Object.assign(unit, {
      active: 'failed',
      sub: 'failed',
      result: 'exit-code',
      exitStatus: 1,
      exitStatusText: 'FAILURE',
      failedPid: pid,
      since: time + 27,
      mainPid: null,
      pids: [],
    });
  }

  _seedPodman(spec) {
    for (const def of spec.catalog || [])
      this._addRegistryImage({ ...def, repo: def.ref || def.repo });
    for (const ref of spec.images || []) this.pullImage(ref, { user: spec.user || 'student' });
    for (const def of spec.containers || []) {
      const pulled = this.pullImage(def.image, { user: spec.user || 'student' });
      if (pulled.error) continue;
      const publish = def.publish ? [def.publish] : def.ports || [];
      const command = Array.isArray(def.command)
        ? def.command
        : def.command
          ? String(def.command).split(/\s+/)
          : def.state === 'running' &&
              !pulled.image.entry.serves &&
              !pulled.image.entry.requiresEnv.length
            ? ['sleep', 'infinity']
            : [];
      const created = this.createContainer(
        {
          name: def.name,
          image: pulled.image,
          imageRef: pulled.resolved.ref,
          ports: publish,
          env: def.env || {},
          command,
        },
        { user: spec.user || 'student' }
      );
      if (created.error) continue;
      const container = created.container;
      const age = Number(def.minutesAgo ?? 50) * 60000;
      container.created = this.resetAt - age;
      if (def.state === 'running' || def.state === undefined) {
        this.startContainer(container);
        container.startedAt = this.resetAt - age + 1000;
        for (const pid of container.pids) {
          const process = this.processes.get(pid);
          if (process) process.start = container.startedAt;
        }
      } else if (def.state === 'exited') {
        container.state = 'exited';
        container.exitCode = Number(def.exitCode ?? 0);
        container.startedAt = this.resetAt - age + 1000;
        container.finishedAt = this.resetAt - age + 60000;
      }
    }
  }

  // ── shell session ────────────────────────────────────────────────────────

  /** Push a login shell (`sudo -i`, `su -`): `exit` returns to the previous one. */
  pushLogin(user, { cwd } = {}) {
    this.session.stack.push({
      user: this.session.user,
      cwd: this.session.cwd,
      oldpwd: this.session.oldpwd,
    });
    this.session.user = user;
    this.session.oldpwd = null;
    this.session.cwd = cwd || this.homeOf(user);
    return this.session;
  }

  /** Leave a nested login shell; false when this is the outermost shell. */
  popLogin() {
    const previous = this.session.stack.pop();
    if (!previous) return false;
    this.session.user = previous.user;
    this.session.cwd = previous.cwd;
    this.session.oldpwd = previous.oldpwd;
    return true;
  }

  /** `[student@workstation ~]$` (bash `\u@\h \W` + `$`/`#`). */
  prompt() {
    const cwd = this.session.cwd;
    const home = this.homeOf(this.session.user);
    const short = cwd === home ? '~' : cwd === '/' ? '/' : basenameOf(cwd);
    const sigil = this.session.user === 'root' ? '#' : '$';
    return `[${this.session.user}@${this.hostname.split('.')[0]} ${short}]${sigil}`;
  }

  /** Record one executed shell command (for the `ran` objective). */
  recordExec(entry) {
    this.execLog.push({
      time: this.now(),
      cwd: this.session.cwd,
      user: this.session.user,
      ...entry,
    });
    if (this.execLog.length > 400) this.execLog.shift();
  }

  // ── query API (pure reads for ObjectiveEvaluator) ────────────────────────

  /** File facts for grading (root view: permissions never hide state). */
  fileInfo(path) {
    this.sync();
    const abs = this.resolvePath(path, { cwd: HOME });
    const walked = this._walk(abs, null, true);
    if (walked.error || !walked.node) {
      const link = this._walk(abs, null, false);
      if (link.node && link.node.type === 'link') {
        return { exists: false, path: abs, type: 'link', dangling: true };
      }
      return { exists: false, path: abs };
    }
    const node = walked.node;
    const lnode = this._walk(abs, null, false).node;
    return {
      exists: true,
      path: walked.path,
      type: node.type,
      isSymlink: lnode?.type === 'link',
      mode: node.mode & 0o7777,
      owner: this.userName(node.uid),
      group: this.groupName(node.gid),
      uid: node.uid,
      gid: node.gid,
      context: node.context,
      content: node.type === 'file' ? this._content(walked.path, node) : null,
      mtime: node.mtime,
      children: node.type === 'dir' ? this._childNames(walked.path) : null,
    };
  }

  serviceState(name) {
    const unit = this.getUnit(name);
    if (!unit)
      return { exists: false, active: false, enabled: false, failed: false, state: 'inactive' };
    return {
      exists: true,
      name: unit.name,
      active: unit.active === 'active',
      state: unit.active,
      failed: unit.active === 'failed',
      enabled: unit.enabled === 'enabled',
      enabledState: unit.enabled,
      mainPid: unit.mainPid,
    };
  }

  processRunning(nameOrPattern, { user, full = false, pid } = {}) {
    if (pid !== undefined && pid !== null) return this.processes.has(Number(pid));
    return this.listProcesses().some((process) => {
      if (process.kernel) return false;
      if (user && process.user !== user) return false;
      try {
        const regex = new RegExp(nameOrPattern);
        return full
          ? regex.test(process.args)
          : regex.test(process.comm) || process.comm === nameOrPattern;
      } catch {
        return process.comm === nameOrPattern || process.args.includes(nameOrPattern);
      }
    });
  }

  packageInstalled(name) {
    return this.isInstalled(name);
  }

  firewallHas({ service, port, zone, runtime, permanent } = {}) {
    const kind = service ? 'service' : 'port';
    const value = service || port;
    const result = {
      runtime: this.firewallQuery(kind, value, { zone, permanent: false }),
      permanent: this.firewallQuery(kind, value, { zone, permanent: true }),
    };
    void runtime;
    void permanent;
    return result;
  }

  containerInfo(name, { user } = {}) {
    const container = this.findContainer(name, { user: user || 'student' });
    if (!container) return { exists: false };
    return {
      exists: true,
      name: container.name,
      id: container.id,
      state: container.state,
      running: container.state === 'running',
      image: container.imageRef,
      ports: container.ports.map((port) => `${port.hostPort}:${port.containerPort}`),
      env: { ...container.env },
    };
  }

  /** The current shell environment entry for grading: `{value, exported}` or null. */
  envVar(name) {
    if (this.session.env.has(name)) return { value: this.session.env.get(name), exported: true };
    if (this.session.vars.has(name)) return { value: this.session.vars.get(name), exported: false };
    return null;
  }
}

/**
 * The workstation state is built lazily: every state field is an accessor that runs a
 * pending `reset()` on first read, so callers keep using plain property access
 * (`host.session.cwd`, `host.units`, …) while an untouched host costs nothing.
 */
const LAZY_STATE_FIELDS = [
  'resetAt',
  'bootTime',
  'installTime',
  'vfsBaseTime',
  'hostname',
  'nodes',
  '_pendingVfs',
  'mirrors',
  'selinux',
  'users',
  'groups',
  'shadow',
  'catalog',
  'installed',
  'units',
  'journal',
  'processes',
  'nextPid',
  'nextJobId',
  'firewall',
  'dns',
  'dnsWildcards',
  'reachable',
  'registry',
  'podman',
  'execLog',
  'httpLog',
  'timeSync',
  'session',
  'shellPid',
  'dnfHistory',
];
for (const field of LAZY_STATE_FIELDS) {
  Object.defineProperty(LinuxHost.prototype, field, {
    configurable: true,
    enumerable: false,
    get() {
      if (this._lazyPending) this.materialize();
      return this._lazyState ? this._lazyState[field] : undefined;
    },
    set(value) {
      if (!this._lazyState) this._lazyState = {};
      this._lazyState[field] = value;
    },
  });
}

/** `8080:8080`, `127.0.0.1:8080:80`, `8080:80/udp`. */
function parsePublish(value) {
  const text = String(value || '').trim();
  const [spec, protoPart] = text.split('/');
  const proto = protoPart || 'tcp';
  const parts = spec.split(':');
  let hostIp = '';
  let hostPort;
  let containerPort;
  if (parts.length === 1) {
    containerPort = Number(parts[0]);
    hostPort = containerPort;
  } else if (parts.length === 2) {
    hostPort = Number(parts[0]);
    containerPort = Number(parts[1]);
  } else {
    hostIp = parts[0];
    hostPort = Number(parts[1]);
    containerPort = Number(parts[2]);
  }
  if (
    !Number.isInteger(hostPort) ||
    !Number.isInteger(containerPort) ||
    hostPort < 1 ||
    hostPort > 65535
  )
    return null;
  return { hostIp, hostPort, containerPort, proto };
}

/**
 * Digest of an image reference (canonical `registry/repo:tag`, `:latest` implied) — the value
 * `skopeo inspect --format '{{.Digest}}'` and `podman inspect` print for catalog images.
 */
export function imageDigest(reference) {
  let text = String(reference || '')
    .trim()
    .replace(/^docker:\/\//, '');
  if (text.includes('@sha256:')) return `sha256:${text.split('@sha256:')[1]}`;
  const lastSlash = text.lastIndexOf('/');
  if (text.lastIndexOf(':') <= lastSlash) text = `${text}:latest`;
  const def = IMAGE_DEFS.find((entry) => text.startsWith(`${entry.repo}:`));
  if (def) return `sha256:${fakeSha256(`${def.repo}:latest`)}`;
  return `sha256:${fakeSha256(text)}`;
}

export { parsePublish, FIREWALL_ZONES, DEFAULT_FIREWALL_SERVICES, IMAGE_DEFS, UNIT_DEFS };

export default LinuxHost;
