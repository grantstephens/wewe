import { registerRootComponent } from 'expo';

import App from './src/App';
import { registerForegroundServiceRunner } from './src/platform/foregroundService';

// Must run outside any React component, before anything can call
// startForegroundSession() — see foregroundService.ts's module doc.
registerForegroundServiceRunner();

registerRootComponent(App);
