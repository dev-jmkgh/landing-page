#!/usr/bin/env node
/**
 * Frees the ports `npm start` needs by stopping whatever is holding them.
 *
 * This exists because the alternative is worse in practice: `npm start` and `npm run
 * dev` want the same two ports, and being told "something is already listening" every
 * time means finding and killing the process by hand before every demo.
 *
 * It is deliberately conservative about *what* it will kill:
 *
 *   - Only Node processes. A port held by anything else — a database, a container
 *     proxy, another application — is reported and left alone, because guessing wrong
 *     there means killing something that has nothing to do with this project.
 *
 *   - The whole supervisor chain, not just the listener. `npm run dev` runs
 *     npm -> tsx/next -> the server that owns the socket. Killing only the listener
 *     leaves the watcher alive, and it immediately restarts a child that takes the port
 *     back — which looks exactly like the kill having failed.
 *
 *   - Never the shell. The climb up the process tree stops as soon as the parent is a
 *     terminal (cmd, PowerShell, bash, Windows Terminal); killing that would close the
 *     window the command was typed into.
 *
 * Exported for `prestart.mjs`; also runnable directly:  node scripts/free-ports.mjs 3000 5000
 */
import { execFileSync } from 'node:child_process';
import { Socket } from 'node:net';
import { pathToFileURL } from 'node:url';

const isWindows = process.platform === 'win32';

/** Process names that are ours to stop. */
const NODE_NAMES = new Set(['node', 'node.exe', 'npm', 'npm.cmd', 'npx', 'npx.cmd']);

/** Terminals and shells — the climb must never reach past these. */
const SHELL_NAMES = new Set([
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'bash.exe',
  'sh',
  'bash',
  'zsh',
  'fish',
  'windowsterminal.exe',
  'conhost.exe',
  'explorer.exe',
  'code.exe',
  'wsl.exe',
]);

function run(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return '';
  }
}

/** True when something is listening on the port. */
export function portInUse(port) {
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(400);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}

/** PIDs listening on the port. More than one is normal — IPv4 and IPv6 entries. */
function listenerPids(port) {
  const pids = new Set();

  if (isWindows) {
    for (const line of run('netstat', ['-ano', '-p', 'TCP']).split('\n')) {
      // e.g.  TCP    0.0.0.0:3000    0.0.0.0:0    LISTENING    12345
      if (!line.includes('LISTENING')) continue;
      const parts = line.trim().split(/\s+/);
      const local = parts[1] ?? '';
      const pid = Number(parts[parts.length - 1]);
      // Match the port exactly: ':3000' must not also match ':30000'.
      if (local.endsWith(`:${port}`) && Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
  } else {
    const out = run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']);
    for (const line of out.split('\n')) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
  }

  return [...pids];
}

/** `{ pid, name, ppid }` for a process, or null if it has already gone. */
function describeProcess(pid) {
  if (isWindows) {
    const out = run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue; ` +
        'if ($p) { "$($p.Name)`t$($p.ParentProcessId)" }',
    ]).trim();

    if (!out) return null;
    const [name = '', ppid = ''] = out.split('\t');
    return { pid, name: name.trim(), ppid: Number(ppid) || 0 };
  }

  const out = run('ps', ['-o', 'comm=,ppid=', '-p', String(pid)]).trim();
  if (!out) return null;
  const parts = out.split(/\s+/);
  const ppid = Number(parts.pop());
  return { pid, name: (parts.join(' ').split('/').pop() ?? '').trim(), ppid: ppid || 0 };
}

function isNodeProcess(process_) {
  return NODE_NAMES.has(process_.name.toLowerCase());
}

function isShell(process_) {
  return SHELL_NAMES.has(process_.name.toLowerCase());
}

/**
 * The listener plus every Node ancestor above it, topmost first.
 *
 * Killing the topmost supervisor first is what stops a watcher from respawning the
 * child we just killed. The climb halts at a shell so the user's terminal survives.
 */
function supervisorChain(pid) {
  const chain = [];
  let current = describeProcess(pid);
  let guard = 0;

  while (current && guard < 8) {
    if (!isNodeProcess(current)) break;
    chain.push(current);

    const parent = current.ppid ? describeProcess(current.ppid) : null;
    if (!parent || isShell(parent) || !isNodeProcess(parent)) break;

    current = parent;
    guard += 1;
  }

  return chain.reverse();
}

function killTree(pid) {
  if (isWindows) {
    run('taskkill', ['/PID', String(pid), '/T', '/F']);
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/**
 * Stops whatever is listening on `port`.
 *
 * Returns `{ freed, killed, blockedBy }` — `blockedBy` is set when the port is held by
 * something this script will not kill, so the caller can report it rather than pretend
 * the port is available.
 */
export async function freePort(port) {
  if (!(await portInUse(port))) return { freed: true, killed: [], blockedBy: null };

  const killed = [];

  for (const pid of listenerPids(port)) {
    const owner = describeProcess(pid);
    if (!owner) continue;

    if (!isNodeProcess(owner)) {
      return { freed: false, killed, blockedBy: `${owner.name} (PID ${owner.pid})` };
    }

    // Topmost supervisor first, so nothing respawns the child we are about to stop.
    for (const process_ of supervisorChain(pid)) {
      killTree(process_.pid);
      killed.push(process_);
    }
  }

  // A killed process does not release its socket instantly.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await portInUse(port))) return { freed: true, killed, blockedBy: null };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return { freed: false, killed, blockedBy: 'the port did not become available' };
}

// Direct invocation: node scripts/free-ports.mjs 3000 5000
// pathToFileURL rather than string concatenation: on Windows argv[1] is `C:\path`,
// which has to become `file:///C:/path` to match import.meta.url.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ports = process.argv.slice(2).map(Number).filter(Boolean);
  for (const port of ports.length ? ports : [3000, 5000]) {
    const result = await freePort(port);
    console.log(
      `${port}: ${result.freed ? 'free' : `blocked by ${result.blockedBy}`}` +
        (result.killed.length ? ` (stopped ${result.killed.map((p) => p.pid).join(', ')})` : ''),
    );
  }
}
