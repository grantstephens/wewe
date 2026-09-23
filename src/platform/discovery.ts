import Zeroconf, { type Service } from 'react-native-zeroconf';

/** Custom mDNS service type this app's monitors (phone or ESP32) advertise themselves under. */
const SERVICE_TYPE = 'wewe-pair';
const SERVICE_PROTOCOL = 'tcp';

export interface DiscoveredMonitor {
  name: string;
  host: string;
  port: number;
  /** The pairing code from the service's TXT record, if the monitor published one. */
  pairingCode: string | null;
}

function toDiscoveredMonitor(service: Service): DiscoveredMonitor {
  return {
    name: service.name,
    host: service.host,
    port: service.port,
    pairingCode: typeof service.txt?.['code'] === 'string' ? service.txt['code'] : null,
  };
}

/**
 * DiscoveryScanner is UX sugar only (see PLAN.md: "mDNS is UX sugar for
 * same-LAN discovery only — the transport is always WebRTC regardless of
 * LAN or remote"). Many "IoT" and guest WiFi networks block multicast
 * entirely, so AddMonitor always offers manual code entry / QR scanning
 * alongside whatever this surfaces, never in place of it.
 */
export class DiscoveryScanner {
  private readonly zeroconf = new Zeroconf();

  start(onUpdate: (monitors: DiscoveredMonitor[]) => void): void {
    const emit = () => onUpdate(Object.values(this.zeroconf.getServices()).map(toDiscoveredMonitor));
    this.zeroconf.on('resolved', emit);
    this.zeroconf.on('remove', emit);
    this.zeroconf.scan(SERVICE_TYPE, SERVICE_PROTOCOL);
  }

  stop(): void {
    this.zeroconf.stop();
    this.zeroconf.removeAllListeners();
  }
}

/**
 * MonitorAdvertiser publishes this device's pairing code over mDNS while
 * acting as a monitor, so a parent on the same LAN can find it in
 * `DiscoveryScanner` without typing or scanning anything. `port` is
 * nominal — the monitor's actual media path is WebRTC via the signaling
 * relay, not a socket this service's port number ever connects to — but
 * `publishService` requires one, so it's a fixed placeholder.
 */
export class MonitorAdvertiser {
  private readonly zeroconf = new Zeroconf();
  private published = false;

  publish(deviceName: string, pairingCode: string): void {
    this.zeroconf.publishService(SERVICE_TYPE, SERVICE_PROTOCOL, 'local.', deviceName, 7532, { code: pairingCode });
    this.published = true;
  }

  unpublish(deviceName: string): void {
    if (!this.published) return;
    this.zeroconf.unpublishService(deviceName);
    this.published = false;
  }
}
