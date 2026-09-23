import { argbFromHex, hexFromArgb, themeFromSourceColor } from '@material/material-color-utilities';
import { MD3DarkTheme, MD3LightTheme, type MD3Theme } from 'react-native-paper';

/**
 * The whole app's color system, generated from one seed: the deep indigo
 * night-sky color behind the app icon's crescent moon. Same approach as the
 * sibling DriveWell project — `@material/material-color-utilities` is
 * Google's own pure-JS/TS implementation of the Material 3 color algorithm,
 * deliberately not a package that bundles native code for system wallpaper
 * theming this app has no use for.
 */
const SEED_COLOR = '#1A2140';

/** toHexColors converts one generated ARGB color-role scheme to hex strings. */
function toHexColors(scheme: { toJSON(): Record<string, number> }): Record<string, string> {
  const hex: Record<string, string> = {};
  for (const [role, argb] of Object.entries(scheme.toJSON())) {
    hex[role] = hexFromArgb(argb);
  }
  return hex;
}

const generated = themeFromSourceColor(argbFromHex(SEED_COLOR));

export const lightTheme: MD3Theme = {
  ...MD3LightTheme,
  colors: { ...MD3LightTheme.colors, ...toHexColors(generated.schemes.light) },
};

export const darkTheme: MD3Theme = {
  ...MD3DarkTheme,
  colors: { ...MD3DarkTheme.colors, ...toHexColors(generated.schemes.dark) },
};

export type Theme = MD3Theme;
