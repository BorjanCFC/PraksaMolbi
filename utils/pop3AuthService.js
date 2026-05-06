const tls = require('tls');
const net = require('net');

function readLine(socket, state, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('IMAP read timeout'));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      socket.off('data', onData);
      socket.off('error', onError);
    }

    function tryResolve() {
      const index = state.buffer.indexOf('\r\n');

      if (index !== -1) {
        const line = state.buffer.slice(0, index);
        state.buffer = state.buffer.slice(index + 2);
        cleanup();
        resolve(line);
        return true;
      }

      return false;
    }

    function onData(chunk) {
      state.buffer += chunk.toString('utf8');
      tryResolve();
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    socket.on('data', onData);
    socket.on('error', onError);

    tryResolve();
  });
}

function sendCommand(socket, command) {
  socket.write(`${command}\r\n`);
}

function escapeImapString(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function getImapUsername(email) {
  const mode =
    process.env.FEIT_IMAP_USERNAME_MODE ||
    process.env.FEIT_POP3_USERNAME_MODE ||
    'email';

  if (mode === 'localpart') {
    return email.split('@')[0];
  }

  return email;
}

function getImapServerConfig(authServer) {
  if (authServer === 'makedon') {
    return {
      host: process.env.FEIT_IMAP_MAKEDON_HOST || 'makedon.feit.ukim.edu.mk',
      port: Number(process.env.FEIT_IMAP_MAKEDON_PORT || 993),
      useTls: String(process.env.FEIT_IMAP_MAKEDON_TLS || 'true') === 'true',
      rejectUnauthorized:
        String(process.env.FEIT_IMAP_MAKEDON_REJECT_UNAUTHORIZED || 'true') === 'true',
      ciphers:
        process.env.FEIT_IMAP_MAKEDON_CIPHERS ||
        'DEFAULT:@SECLEVEL=1',
      serverName:
        process.env.FEIT_IMAP_MAKEDON_SERVERNAME ||
        process.env.FEIT_IMAP_MAKEDON_HOST ||
        'makedon.feit.ukim.edu.mk'
    };
  }

  return {
    host: process.env.FEIT_IMAP_HOST || process.env.FEIT_POP3_HOST || 'smail.feit.ukim.edu.mk',
    port: Number(process.env.FEIT_IMAP_PORT || 993),
    useTls: String(process.env.FEIT_IMAP_TLS || 'true') === 'true',
    rejectUnauthorized:
      String(process.env.FEIT_IMAP_REJECT_UNAUTHORIZED || 'true') === 'true',
    ciphers:
      process.env.FEIT_IMAP_CIPHERS ||
      process.env.FEIT_POP3_CIPHERS ||
      'DEFAULT:@SECLEVEL=1',
    serverName:
      process.env.FEIT_IMAP_SERVERNAME ||
      process.env.FEIT_IMAP_HOST ||
      'smail.feit.ukim.edu.mk'
  };
}

async function readTaggedResponse(socket, state, tag) {
  while (true) {
    const line = await readLine(socket, state);

    if (
      line.startsWith(`${tag} OK`) ||
      line.startsWith(`${tag} NO`) ||
      line.startsWith(`${tag} BAD`)
    ) {
      return line;
    }
  }
}

// Името останува verifyPop3Credentials за да не мораш да менуваш authController.
// Реално ова прави IMAP authentication.
async function verifyPop3Credentials(email, password, authServer = 'smail') {
  return new Promise((resolve) => {
    const cleanEmail = String(email || '').trim().toLowerCase();
    const username = getImapUsername(cleanEmail);
    const config = getImapServerConfig(authServer);

    const state = {
      buffer: ''
    };

    const socket = config.useTls
      ? tls.connect({
          host: config.host,
          port: config.port,
          servername: config.serverName,
          rejectUnauthorized: config.rejectUnauthorized,
          ciphers: config.ciphers,
          minVersion: 'TLSv1.2'
        })
      : net.connect({
          host: config.host,
          port: config.port
        });

    socket.setTimeout(15000);

    let finished = false;

    function finish(result) {
      if (finished) return;
      finished = true;

      try {
        socket.end();
      } catch (error) {
        // ignore socket close errors
      }

      resolve(result);
    }

    socket.on('timeout', () => {
      socket.destroy();
      finish(false);
    });

    socket.on('error', (error) => {
      console.error(`[IMAP] Socket error for ${cleanEmail} on ${config.host}:`, error.message);
      finish(false);
    });

    const readyEvent = config.useTls ? 'secureConnect' : 'connect';

    socket.once(readyEvent, async () => {
      try {
        const greeting = await readLine(socket, state);

        if (!greeting.startsWith('* OK')) {
          return finish(false);
        }

        const safeUsername = escapeImapString(username);
        const safePassword = escapeImapString(password);

        sendCommand(socket, `a1 LOGIN "${safeUsername}" "${safePassword}"`);

        const loginResponse = await readTaggedResponse(socket, state, 'a1');
        const authenticated = loginResponse.startsWith('a1 OK');

        sendCommand(socket, 'a2 LOGOUT');

        return finish(authenticated);
      } catch (error) {
        console.error(`[IMAP] Auth error for ${cleanEmail} on ${config.host}:`, error.message);
        socket.destroy();
        return finish(false);
      }
    });
  });
}

module.exports = {
  verifyPop3Credentials
};