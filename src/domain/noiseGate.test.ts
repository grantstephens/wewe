import { NoiseGate } from './noiseGate';

/** Feeds `levelDb` samples 100ms apart, starting at t=0, returning the gate state after the last one. */
function feed(gate: NoiseGate, levels: number[], stepMs = 100, startMs = 0): boolean {
  let open = gate.isOpen;
  let t = startMs;
  for (const level of levels) {
    open = gate.push(level, t);
    t += stepMs;
  }
  return open;
}

describe('NoiseGate', () => {
  it('stays closed while readings sit at the initial floor', () => {
    const gate = new NoiseGate();
    const open = feed(gate, new Array(50).fill(-50));
    expect(open).toBe(false);
  });

  it('opens as soon as a sample clears floor + openMarginDb', () => {
    const gate = new NoiseGate({ initialFloorDb: -50, openMarginDb: 12 });
    expect(gate.push(-50, 0)).toBe(false);
    expect(gate.push(-30, 100)).toBe(true);
  });

  it('does not close immediately on a brief dip below threshold (closeHoldMs hysteresis)', () => {
    const gate = new NoiseGate({ initialFloorDb: -50, openMarginDb: 12, closeHoldMs: 3000 });
    gate.push(-20, 0); // opens
    expect(gate.push(-55, 1000)).toBe(true); // a quiet breath mid-cry, well inside the hold window
  });

  it('closes once quiet persists past closeHoldMs', () => {
    const gate = new NoiseGate({ initialFloorDb: -50, openMarginDb: 12, closeHoldMs: 3000 });
    gate.push(-20, 0); // opens
    gate.push(-55, 1000);
    expect(gate.push(-55, 4001)).toBe(false);
  });

  it('adapts the floor upward toward a sustained quieter-than-initial ambient level', () => {
    const gate = new NoiseGate({ initialFloorDb: -50, floorTimeConstantMs: 1000 });
    feed(gate, new Array(200).fill(-40), 100); // room is ambiently louder than assumed
    expect(gate.noiseFloorDb).toBeGreaterThan(-45);
    expect(gate.noiseFloorDb).toBeLessThan(-39);
  });

  it('never adapts the floor while the gate is open, so a loud gate-opening event cannot mask itself', () => {
    const gate = new NoiseGate({ initialFloorDb: -50, openMarginDb: 12, floorTimeConstantMs: 200, closeHoldMs: 60000 });
    gate.push(-20, 0); // opens; a real implementation must freeze the floor here
    for (let i = 1; i <= 50; i++) {
      gate.push(-20, i * 100); // sustained loud cry
    }
    expect(gate.noiseFloorDb).toBe(-50);
    expect(gate.isOpen).toBe(true);
  });

  it('filters out a sustained, unmodulating noise source once it has held steady past stationaryHoldMs', () => {
    const gate = new NoiseGate({ initialFloorDb: -50, openMarginDb: 12, stationaryHoldMs: 5000, stationaryRangeDb: 3 });
    const open = feed(gate, new Array(60).fill(-20), 100); // 5.9s of a perfectly flat "white noise machine" tone
    expect(open).toBe(false);
    expect(gate.noiseFloorDb).toBeGreaterThan(-25);
    expect(gate.noiseFloorDb).toBeLessThan(-15);
  });

  it('never filters a modulating source — a cry-like pattern with breathing gaps stays open past the same hold duration', () => {
    const gate = new NoiseGate({ initialFloorDb: -50, openMarginDb: 12, closeHoldMs: 3000, stationaryHoldMs: 5000, stationaryRangeDb: 3 });
    const levels: number[] = [];
    for (let cycle = 0; cycle < 6; cycle++) {
      for (let i = 0; i < 9; i++) levels.push(-20); // sustained wail
      levels.push(-45); // breath between wails, below floor + margin
      levels.push(-45);
    }
    const open = feed(gate, levels, 100); // 6.6s total, longer than the 5s hold that would filter a flat tone
    expect(open).toBe(true);
  });

  it('reopens for a genuine loud event after the floor has snapped up to a learned noise level', () => {
    const gate = new NoiseGate({ initialFloorDb: -50, openMarginDb: 12, stationaryHoldMs: 3000, stationaryRangeDb: 3 });
    feed(gate, new Array(35).fill(-30), 100); // ~3.5s flat tone -> learned as noise, floor snaps to ~-30
    expect(gate.isOpen).toBe(false);
    expect(gate.push(-10, 3600)).toBe(true); // a cry well above the newly learned floor
  });
});
