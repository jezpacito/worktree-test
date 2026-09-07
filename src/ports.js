// ports.js
// Allocates ports starting at config.startPort (default 5002), incrementing
// for each successive worktree, and reclaiming ports when a worktree is
// removed. Also does a best-effort live check that the OS actually thinks
// the port is free before handing it out, in case something outside the
// dashboard is squatting on it.

const net = require('net');

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, '127.0.0.1');
  });
}

async function allocatePort(state) {
  const used = new Set(Object.values(state.worktrees).map((w) => w.port));
  let candidate = Math.max(state.config.startPort, state.nextPort || state.config.startPort);
  // scan upward for the first port that's neither tracked as in-use nor
  // actually bound on the OS
  for (let tries = 0; tries < 500; tries++) {
    if (!used.has(candidate) && (await isPortFree(candidate))) {
      state.nextPort = candidate + 1;
      return candidate;
    }
    candidate++;
  }
  throw new Error('Could not find a free port after 500 attempts');
}

module.exports = { allocatePort, isPortFree };
