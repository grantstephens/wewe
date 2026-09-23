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
});
