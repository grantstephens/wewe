/**
 * The app's one stack: mode select (Home), becoming a monitor, watching a
 * paired monitor, adding one, and settings. A stack rather than DriveWell's
 * bottom-tab bar because "Home" here is a branch point (become a monitor vs.
 * watch one), not a peer destination alongside the others.
 */
export type RootStackParamList = {
  Home: undefined;
  Monitor: undefined;
  Parent: { monitorId: string };
  AddMonitor: undefined;
  Settings: undefined;
};
