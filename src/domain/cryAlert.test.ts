import { CryAlertClassifier } from './cryAlert';

describe('CryAlertClassifier', () => {
  it('alerts instantly on a sample at or above instantAlertDb', () => {
    const classifier = new CryAlertClassifier({ instantAlertDb: -18, sustainedAlertMs: 4000 });
    expect(classifier.push(-30, 0)).toBe(false);
    expect(classifier.push(-10, 100)).toBe(true);
  });

  it('alerts once sustained duration passes, even if never loud', () => {
    const classifier = new CryAlertClassifier({ instantAlertDb: -18, sustainedAlertMs: 4000 });
    expect(classifier.push(-30, 0)).toBe(false);
    expect(classifier.push(-30, 3999)).toBe(false);
    expect(classifier.push(-30, 4000)).toBe(true);
  });

  it('never alerts twice for the same open period', () => {
    const classifier = new CryAlertClassifier({ instantAlertDb: -18 });
    expect(classifier.push(-10, 0)).toBe(true);
    expect(classifier.push(-10, 100)).toBe(false);
    expect(classifier.push(-10, 200)).toBe(false);
  });

  it('judges the next open period fresh after reset', () => {
    const classifier = new CryAlertClassifier({ instantAlertDb: -18 });
    expect(classifier.push(-10, 0)).toBe(true);
    classifier.reset();
    expect(classifier.push(-30, 1000)).toBe(false);
    expect(classifier.push(-10, 1100)).toBe(true);
  });

  it('does not alert on a brief quiet sound that never gets loud or long', () => {
    const classifier = new CryAlertClassifier({ instantAlertDb: -18, sustainedAlertMs: 4000 });
    expect(classifier.push(-40, 0)).toBe(false);
    expect(classifier.push(-40, 500)).toBe(false);
  });
});
