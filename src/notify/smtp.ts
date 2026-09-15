import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { EmailChannel } from './notifier.js';

// Minimal SMTP submission client (decision 77): EHLO, STARTTLS when offered on plain
// connections, AUTH LOGIN when credentials are set, one RFC 5322 text message.
// Deliberately no dependency: Harbor sends a handful of notification mails, nothing more.

const TIMEOUT = 15_000;

class SmtpSession {
  private buf = '';
  private waiters: { resolve: (line: string) => void; reject: (e: Error) => void }[] = [];
  constructor(private sock: Socket | TLSSocket) {
    sock.setTimeout(TIMEOUT, () => this.fail(new Error('SMTP timeout')));
    sock.on('data', (d: Buffer) => {
      this.buf += d.toString('utf8');
      this.drain();
    });
    sock.on('error', (e: Error) => this.fail(e));
    sock.on('close', () => this.fail(new Error('SMTP connection closed')));
  }
  swap(sock: TLSSocket): void {
    this.sock.removeAllListeners();
    this.sock = sock;
    sock.setTimeout(TIMEOUT, () => this.fail(new Error('SMTP timeout')));
    sock.on('data', (d: Buffer) => {
      this.buf += d.toString('utf8');
      this.drain();
    });
    sock.on('error', (e: Error) => this.fail(e));
  }
  private drain(): void {
    // A reply ends with a line "NNN " (space after the code); multiline replies use "NNN-".
    for (;;) {
      const m = this.buf.match(/^([\s\S]*?\r\n)?(\d{3}) [^\r\n]*\r\n/);
      if (!m || !this.waiters.length) return;
      const whole = m[0];
      this.buf = this.buf.slice(whole.length);
      this.waiters.shift()!.resolve(whole.trimEnd());
    }
  }
  private fail(e: Error): void {
    while (this.waiters.length) this.waiters.shift()!.reject(e);
  }
  reply(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.drain();
    });
  }
  async cmd(line: string, expect: number[]): Promise<string> {
    this.sock.write(line + '\r\n');
    const r = await this.reply();
    const code = Number(r.slice(r.lastIndexOf('\n') + 1, r.lastIndexOf('\n') + 4) || r.slice(0, 3));
    if (!expect.includes(code)) throw new Error(`SMTP ${line.split(' ')[0]} failed: ${r.split('\r\n').pop()}`);
    return r;
  }
  end(): void {
    this.sock.end();
  }
  raw(): Socket | TLSSocket {
    return this.sock;
  }
}

export async function sendSmtp(ch: EmailChannel, subject: string, text: string): Promise<{ ok: boolean; error: string | null }> {
  let session: SmtpSession | null = null;
  try {
    const sock = ch.smtp.secure
      ? tlsConnect({ host: ch.smtp.host, port: ch.smtp.port, servername: ch.smtp.host })
      : netConnect({ host: ch.smtp.host, port: ch.smtp.port });
    await new Promise<void>((resolve, reject) => {
      sock.once(ch.smtp.secure ? 'secureConnect' : 'connect', resolve);
      sock.once('error', reject);
    });
    session = new SmtpSession(sock);
    await session.reply(); // greeting
    const ehlo = await session.cmd('EHLO harbor.local', [250]);
    if (!ch.smtp.secure && /STARTTLS/i.test(ehlo)) {
      await session.cmd('STARTTLS', [220]);
      const tls = tlsConnect({ socket: session.raw() as Socket, servername: ch.smtp.host });
      await new Promise<void>((resolve, reject) => {
        tls.once('secureConnect', resolve);
        tls.once('error', reject);
      });
      session.swap(tls);
      await session.cmd('EHLO harbor.local', [250]);
    }
    if (ch.smtp.user) {
      await session.cmd('AUTH LOGIN', [334]);
      await session.cmd(Buffer.from(ch.smtp.user).toString('base64'), [334]);
      await session.cmd(Buffer.from(ch.smtp.pass ?? '').toString('base64'), [235]);
    }
    await session.cmd(`MAIL FROM:<${ch.from}>`, [250]);
    await session.cmd(`RCPT TO:<${ch.to}>`, [250, 251]);
    await session.cmd('DATA', [354]);
    const msg = [
      `From: Harbor <${ch.from}>`,
      `To: <${ch.to}>`,
      `Subject: ${subject.replace(/[\r\n]/g, ' ')}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      text.replace(/^\./gm, '..'),
    ].join('\r\n');
    await session.cmd(msg + '\r\n.', [250]);
    await session.cmd('QUIT', [221]).catch(() => {});
    session.end();
    return { ok: true, error: null };
  } catch (e) {
    session?.end();
    return { ok: false, error: (e as Error).message };
  }
}
