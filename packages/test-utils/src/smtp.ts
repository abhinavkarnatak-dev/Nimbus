import { createServer, type Server, type Socket } from 'node:net';

const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
const LINE_FEED = String.fromCharCode(10);

export type FakeSmtpBehaviour = 'accept' | 'reject-auth' | 'never-greet';

export interface FakeSmtpOptions {
  behaviour?: FakeSmtpBehaviour;
  rejectionMessage?: string;
}

export interface FakeSmtpServer {
  port: number;
  receivedCommands: string[];
  close: () => Promise<void>;
}

function reply(socket: Socket, line: string): void {
  socket.write(line + CRLF);
}

export async function startFakeSmtpServer(options: FakeSmtpOptions = {}): Promise<FakeSmtpServer> {
  const behaviour = options.behaviour ?? 'accept';
  const rejectionMessage =
    options.rejectionMessage ?? '535 5.7.8 Authentication credentials invalid';
  const receivedCommands: string[] = [];

  const server: Server = createServer((socket) => {
    socket.setEncoding('utf8');

    if (behaviour === 'never-greet') {
      return;
    }

    reply(socket, '220 fake.nimbus.test ESMTP ready');

    let buffer = '';
    let inData = false;

    socket.on('data', (chunk: string) => {
      buffer += chunk;

      let breakAt = buffer.indexOf(LINE_FEED);
      while (breakAt !== -1) {
        const line = buffer.slice(0, breakAt).replace(CRLF, '').trimEnd();
        buffer = buffer.slice(breakAt + 1);
        breakAt = buffer.indexOf(LINE_FEED);

        if (inData) {
          if (line === '.') {
            inData = false;
            reply(socket, '250 2.0.0 Ok queued');
          }
          continue;
        }

        receivedCommands.push(line);
        const upper = line.toUpperCase();

        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          reply(socket, '250-fake.nimbus.test');
          reply(socket, '250-AUTH PLAIN LOGIN');
          reply(socket, '250 8BITMIME');
        } else if (upper === 'STARTTLS') {
          reply(socket, '454 4.7.0 TLS not available on this server');
        } else if (upper.startsWith('AUTH')) {
          if (behaviour === 'reject-auth') {
            reply(socket, rejectionMessage);
          } else {
            reply(socket, '235 2.7.0 Accepted');
          }
        } else if (upper.startsWith('MAIL FROM') || upper.startsWith('RCPT TO')) {
          reply(socket, '250 2.1.0 Ok');
        } else if (upper === 'DATA') {
          inData = true;
          reply(socket, '354 End data with a single dot');
        } else if (upper === 'QUIT') {
          reply(socket, '221 2.0.0 Bye');
          socket.end();
        } else {
          reply(socket, '250 2.0.0 Ok');
        }
      }
    });

    socket.on('error', () => {
      socket.destroy();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    port,
    receivedCommands,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
