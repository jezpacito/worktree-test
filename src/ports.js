// ports.js
// Allocates ports starting at config.startPort (default 5002), incrementing
// for each successive worktree, and reclaiming ports when a worktree is
// removed. Also does a best-effort live check that the OS actually thinks
// the port is free before handing it out, in case something outside the
// dashboard is squatting on it.
//
// You can also name a port yourself when creating a worktree; validatePort
// is what the API uses to decide whether that request is sane.

const net = require('net');

const MIN_PORT = 1024;
const MAX_PORT = 65535;

function bindable(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, host);
  });
}

// Checked on both the loopback and the wildcard address: a service bound to
// 0.0.0.0 (common with corporate agents and Docker) leaves 127.0.0.1 looking
// free, and the dev server then fails to bind at launch time instead.
async function isPortFree(port) {
  if (!(await bindable(port, '127.0.0.1'))) return false;
  return bindable(port, '0.0.0.0');
}

function portsInUse(state, { excludeId } = {}) {
  return new Set(
    Object.values(state.worktrees)
      .filter((w) => w.id !== excludeId)
      .map((w) => w.port)
      .filter((p) => p != null)
  );
}

// The port allocatePort would hand out next, without consuming it. Used by the
// New Worktree form to pre-fill its port box with a suggestion.
async function findFreePort(state) {
  const used = portsInUse(state);
  let candidate = Math.max(state.config.startPort, state.nextPort || state.config.startPort);
  for (let tries = 0; tries < 500; tries++) {
    if (!used.has(candidate) && (await isPortFree(candidate))) return candidate;
    candidate++;
  }
  throw new Error('Could not find a free port after 500 attempts');
}

async function allocatePort(state) {
  const port = await findFreePort(state);
  state.nextPort = port + 1;
  return port;
}

// Validate a port the user typed. Returns the number; throws with a message
// meant to be shown verbatim in the UI.
async function validatePort(value, state, { excludeId } = {}) {
  const port = Number(value);
  if (!Number.isInteger(port)) {
    throw new Error(`Port must be a whole number, got: ${value}`);
  }
  if (port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`Port must be between ${MIN_PORT} and ${MAX_PORT}, got: ${port}`);
  }
  const taken = Object.values(state.worktrees).find((w) => w.port === port && w.id !== excludeId);
  if (taken) {
    throw new Error(`Port ${port} is already assigned to the worktree on branch "${taken.branch}".`);
  }
  if (!(await isPortFree(port))) {
    throw new Error(`Port ${port} is already in use on this machine. Pick another one.`);
  }
  return port;
}

module.exports = { allocatePort, findFreePort, isPortFree, validatePort, MIN_PORT, MAX_PORT };
