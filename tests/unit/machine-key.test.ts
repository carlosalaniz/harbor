import { describe, expect, it } from 'vitest';
import { HarborError } from '../../src/errors.js';
import { createSealedMachineKey, resealMachineKey, unsealMachineKey, zeroMachineKey } from '../../src/auth/machine-key.js';
import { unwrapMasterKeyForMachine, wrapMasterKeyForMachine, zeroKey } from '../../src/storage/app-home.js';
import { randomBytes } from 'node:crypto';

describe('machine keystore (BFU/AFU)', () => {
  it('seals at setup; first login unseals (BFU -> AFU)', async () => {
    const { sealed, machineKey } = await createSealedMachineKey('admin password here');
    try {
      expect(sealed.format).toBe(1);
      expect(sealed.algorithm).toBe('aes-256-gcm');
      // The sealed blob reveals nothing about the key.
      expect(JSON.stringify(sealed)).not.toContain(machineKey.toString('hex'));
      // Simulate a reboot: drop the live key, unseal from the stored blob.
      const rebooted = JSON.parse(JSON.stringify(sealed));
      const live = await unsealMachineKey(rebooted, 'admin password here');
      try {
        expect(live.equals(machineKey)).toBe(true);
      } finally {
        zeroMachineKey(live);
      }
    } finally {
      zeroMachineKey(machineKey);
    }
  });

  it('a wrong password fails like a bad login, without detail', async () => {
    const { sealed, machineKey } = await createSealedMachineKey('admin password here');
    zeroMachineKey(machineKey);
    try {
      await unsealMachineKey(sealed, 'wrong password here!');
      expect.unreachable();
    } catch (e) {
      expect(HarborError.is(e, 'UNAUTHENTICATED')).toBe(true);
    }
  });

  it('password change re-seals the same key; old password stops working', async () => {
    const { sealed, machineKey } = await createSealedMachineKey('old password here');
    try {
      const resealed = await resealMachineKey(machineKey, 'new password here!!');
      const live = await unsealMachineKey(resealed, 'new password here!!');
      try {
        expect(live.equals(machineKey)).toBe(true);
      } finally {
        zeroMachineKey(live);
      }
      await expect(unsealMachineKey(resealed, 'old password here')).rejects.toThrowError(/does not unlock/);
      expect(sealed.sealedKey).not.toBe(resealed.sealedKey);
    } finally {
      zeroMachineKey(machineKey);
    }
  });

  it('the unsealed machine key wraps app-home master keys end to end', async () => {
    const { sealed, machineKey } = await createSealedMachineKey('admin password here');
    const appKey = randomBytes(32);
    try {
      // Install time (AFU): wrap the app key with the live machine key.
      const wrapped = wrapMasterKeyForMachine(appKey, machineKey);
      zeroMachineKey(machineKey);
      // Reboot (BFU): nothing unlocks until login…
      expect(() => unwrapMasterKeyForMachine(wrapped, Buffer.alloc(32, 0))).toThrowError(/failed authentication/);
      // …first login unseals, and the app key opens again.
      const live = await unsealMachineKey(sealed, 'admin password here');
      try {
        const opened = unwrapMasterKeyForMachine(wrapped, live);
        try {
          expect(opened.equals(appKey)).toBe(true);
        } finally {
          zeroKey(opened);
        }
      } finally {
        zeroMachineKey(live);
      }
    } finally {
      zeroKey(appKey);
    }
  });

  it('a damaged blob refuses with a recovery pointer, not a crash', async () => {
    const { sealed, machineKey } = await createSealedMachineKey('admin password here');
    zeroMachineKey(machineKey);
    const bad = { ...sealed, format: 99 as unknown as 1 };
    await expect(unsealMachineKey(bad, 'admin password here')).rejects.toThrowError(/unsupported format/);
    const truncated = { ...sealed, sealedKey: sealed.sealedKey.slice(0, 32) };
    await expect(unsealMachineKey(truncated, 'admin password here')).rejects.toThrow();
  });
});
