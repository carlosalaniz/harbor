import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, otpauthUrl, totpCode, verifyTotp } from '../../src/auth/totp.js';
import { polkitPowerRule, harborUnit, tailscaleOperatorUnit } from '../../src/bootstrap/systemd.js';
import { demuxDockerLogs } from '../../src/system/logs.js';

describe('TOTP (RFC 6238)', () => {
  // RFC 6238 appendix B, SHA-1 vectors with the 20-byte ASCII secret "12345678901234567890" (8 digits in the RFC; we use 6, i.e. the last six)
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it('round-trips base32 and matches the reference vectors', () => {
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(totpCode(secret, 59_000)).toBe('287082'.slice(-6)); // 94287082
    expect(totpCode(secret, 1_111_111_109_000)).toBe('081804'); // 07081804
    expect(totpCode(secret, 1_234_567_890_000)).toBe('005924'); // 89005924
    expect(totpCode(secret, 2_000_000_000_000)).toBe('279037'); // 69279037
  });
  it('verifies with one step of drift either way, rejects garbage', () => {
    const now = 1_234_567_890_000;
    expect(verifyTotp(secret, totpCode(secret, now), now)).toBe(Math.floor(now / 30_000));
    expect(verifyTotp(secret, totpCode(secret, now - 30_000), now)).not.toBeNull();
    expect(verifyTotp(secret, totpCode(secret, now + 30_000), now)).not.toBeNull();
    expect(verifyTotp(secret, totpCode(secret, now + 90_000), now)).toBeNull();
    expect(verifyTotp(secret, '12 34 56', now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
    expect(otpauthUrl(secret, 'admin', 'Harbor (Home)')).toBe(`otpauth://totp/Harbor%20(Home)%3Aadmin?secret=${secret}&issuer=Harbor%20(Home)&algorithm=SHA1&digits=6&period=30`);
  });
});

describe('systemd pieces for v0.7', () => {
  it('unit joins systemd-journal so the console can show Harbor logs; polkit lets harbor start only the operator oneshot', () => {
    expect(harborUnit()).toContain('SupplementaryGroups=docker systemd-journal');
    const rule = polkitPowerRule();
    expect(rule).toContain('action.lookup("unit") === "harbor-tailscale-operator.service"');
    expect(rule).toContain('action.lookup("verb") === "start"');
    expect(rule).toContain('polkit.Result.NOT_HANDLED');
    expect(tailscaleOperatorUnit()).toContain('ExecStart=/usr/bin/tailscale set --operator=harbor');
    expect(tailscaleOperatorUnit()).toContain('Type=oneshot');
  });
  it('demuxes Docker log frames and passes TTY logs through', () => {
    const frame = (stream: number, text: string) => {
      const h = Buffer.alloc(8);
      h[0] = stream;
      h.writeUInt32BE(Buffer.byteLength(text), 4);
      return Buffer.concat([h, Buffer.from(text)]);
    };
    expect(demuxDockerLogs(Buffer.concat([frame(1, 'hello\n'), frame(2, 'oops\n')]))).toBe('hello\noops\n');
    expect(demuxDockerLogs(Buffer.from('plain tty output\n'))).toBe('plain tty output\n');
  });
});
