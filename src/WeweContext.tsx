import React, { createContext, useContext, useMemo, useState } from 'react';

import type { Store } from './domain/store';

export interface WeweValue {
  store: Store;
  /** revision changes whenever stored data changed underneath the screens. */
  revision: number;
  /** bump announces that stored data changed. */
  bump: () => void;
}

const WeweReactContext = createContext<WeweValue | null>(null);

export function WeweProvider({ store, children }: { store: Store; children: React.ReactNode }) {
  const [revision, setRevision] = useState(0);

  const value = useMemo<WeweValue>(
    () => ({ store, revision, bump: () => setRevision((r) => r + 1) }),
    [store, revision],
  );

  return <WeweReactContext.Provider value={value}>{children}</WeweReactContext.Provider>;
}

export function useWewe(): WeweValue {
  const value = useContext(WeweReactContext);
  if (value === null) {
    throw new Error('useWewe must be used inside a WeweProvider');
  }
  return value;
}
