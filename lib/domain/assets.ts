// Devices with a QR sticker: scanning one opens ASK IT already knowing the device.

export interface Asset {
  id: string;
  name: string;
  location: string;
  // Completes "You're ..." in the greeting.
  spoken: string;
  // Guide ids in kb.ts that usually fit this device.
  guides: string[];
}

const ASSET_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const ASSETS: Asset[] = [
  { id: 'room-4b-display', name: 'Meeting room 4B display', location: 'Bengaluru, 4th floor', spoken: "at meeting room 4B's display", guides: ['external-monitor', 'screen-sharing'] },
  { id: 'printer-3f', name: 'Printer, 3rd floor', location: 'Bengaluru, 3rd floor, near the pantry', spoken: 'at the printer by the 3rd floor pantry', guides: ['printer'] },
  { id: 'laptop-nb-2231', name: "Priya's MacBook Pro", location: 'NB-2231, assigned to Priya Sharma', spoken: "on Priya's MacBook Pro", guides: ['slow-laptop'] },
];

export function findAsset(raw: unknown): Asset | undefined {
  if (typeof raw !== 'string' || raw.length > 40 || !ASSET_ID.test(raw)) return undefined;
  return ASSETS.find((a) => a.id === raw);
}

// Written into every ticket raised for the device, so its open ticket can be found again.
export const assetMarker = (id: string) => `Asset: ${id}`;
