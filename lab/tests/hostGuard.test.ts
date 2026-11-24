import { describe, expect, it } from 'vitest';
import { hostChanges, type HostSnapshot } from '../src/hostGuard';

const snapshot = (sysctl: Record<string, string>, volatile: string[], wallMs: number, monoMs: number): HostSnapshot => ({
  sysctl: new Map(Object.entries(sysctl)),
  volatile: new Set(volatile),
  wallMs,
  monoMs,
});

describe("this machine's state around a run", () => {
  it('finds a kernel setting a run changed, not one that changes by itself', () => {
    const before = snapshot({ 'vm.overcommit_memory': '0', 'fs.file-nr': '1024 0 9223372036854775807', 'vm.swappiness': '60' }, ['fs.file-nr'], 1_000_000, 50_000);
    const after = snapshot({ 'vm.overcommit_memory': '1', 'fs.file-nr': '2048 0 9223372036854775807', 'vm.swappiness': '60' }, [], 1_060_000, 110_000);
    expect(hostChanges(before, after)).toEqual({ sysctl: [{ key: 'vm.overcommit_memory', before: '0', after: '1' }], clockShiftMs: 0 });
    // Counters that move slowly, and the settings of a lab's own network links, which come and go with it.
    const slow = snapshot({ 'kernel.pty.nr': '3', 'kernel.ns_last_pid': '4000', 'net.ipv4.conf.veth1a2b3c.forwarding': '1' }, [], 1_000_000, 50_000);
    const later = snapshot({ 'kernel.pty.nr': '5', 'kernel.ns_last_pid': '4100', 'net.ipv4.conf.veth1a2b3c.forwarding': '0' }, [], 1_060_000, 110_000);
    expect(hostChanges(slow, later).sysctl).toEqual([]);
  });

  it("finds the clock set to another time: the wall clock moved more than the machine's own steady clock", () => {
    const before = snapshot({}, [], 1_000_000, 50_000);
    // 60 seconds passed, but the wall clock says an hour and a minute did.
    const after = snapshot({}, [], 1_000_000 + 3_660_000, 110_000);
    expect(hostChanges(before, after).clockShiftMs).toBe(3_600_000);
    // A few milliseconds apart is the two readings, not a change.
    expect(hostChanges(before, snapshot({}, [], 1_060_004, 110_000)).clockShiftMs).toBe(0);
  });
});
