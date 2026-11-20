import { MINUTE } from './time';
import type { Employee } from './types';

// Fictional company and employee.
export const COMPANY = 'Nimbus Labs';

export const EMPLOYEE: Employee = {
  name: 'Deepak Gowda',
  firstName: 'Deepak',
  role: 'Product Manager',
  email: 'deepak.gowda@nimbuslabs.example',
  device: { id: 'NB-2231', model: 'MacBook Pro', os: 'macOS 15' },
  vpnClient: 'GlobalProtect',
};

export const VERIFICATION_TTL_MS = 10 * MINUTE;
export const CODE_TTL_MS = 5 * MINUTE;
export const MAX_CODE_ATTEMPTS = 3;

export const deviceLabel = (e: Employee) => `${e.device.id}, ${e.device.model} on ${e.device.os}`;
