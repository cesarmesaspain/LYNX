/*
 * license-cmd.ts — CLI command: lynx license
 *
 * Usage:
 *   lynx license status         Show current license info
 *   lynx license activate <key> Activate a license key
 */

import { readLicense, saveLicense, refreshLicense, getTier, licenseStatusString } from '../../commercial/license.js';

export function cmdLicense(args: string[]): void {
  const sub = args[0];

  if (sub === 'activate' || sub === 'set') {
    const key = args[1] || '';
    if (!key) {
      console.log('Usage: lynx license activate <license-key>');
      console.log('Get your key at https://lynx.dev/login');
      process.exit(1);
    }
    saveLicense(key);
    const info = readLicense();
    if (info) {
      console.log(`Licencia activada: ${info.tier.toUpperCase()} (${info.email})`);
      console.log(`Expira: ${info.expiresAt.toISOString().slice(0, 10)}`);
    } else {
      console.log('Error: la licencia no es valida. Revisa el key.');
    }
    return;
  }

  if (sub === 'refresh') {
    console.log('Refrescando licencia...');
    refreshLicense().then((ok) => {
      if (ok) {
        console.log('Licencia refrescada.');
        console.log(licenseStatusString());
      } else {
        console.log('No se pudo refrescar. La licencia actual sigue funcionando.');
      }
    });
    return;
  }

  if (sub === 'tier') {
    console.log(getTier());
    return;
  }

  // Default: status
  console.log(licenseStatusString());

  const info = readLicense();
  if (info && info.email) {
    console.log(`Email: ${info.email}`);
    console.log(`Tier: ${info.tier}`);
    console.log(`Valida: ${info.isValid ? 'si' : 'no (degradado a Free)'}`);
  }
}
