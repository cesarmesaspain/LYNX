import { readLynxConfig, upsertLynxConfig } from '../../config/runtime.js';

export function cmdConfig(args: string[]): void {
  const sub = args[0];
  if (!sub || sub === 'get') {
    console.log(JSON.stringify(readLynxConfig(), null, 2));
    return;
  }
  if (sub === 'set') {
    const key = args[1];
    const raw = args[2];
    if (!key || raw === undefined) {
      console.error('Usage: lynx config set <auto_index|auto_watch|auto_dashboard|auto_index_limit|locale> <value>');
      process.exit(1);
    }
    if (key === 'auto_index' || key === 'auto_watch' || key === 'auto_dashboard') {
      const value = raw === 'true' || raw === '1' || raw === 'yes';
      console.log(JSON.stringify(upsertLynxConfig({ [key]: value }), null, 2));
      return;
    }
    if (key === 'auto_index_limit') {
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        console.error('auto_index_limit must be a non-negative number');
        process.exit(1);
      }
      console.log(JSON.stringify(upsertLynxConfig({ auto_index_limit: value }), null, 2));
      return;
    }
    if (key === 'locale') {
      if (raw !== 'es' && raw !== 'en') {
        console.error('locale must be es or en');
        process.exit(1);
      }
      console.log(JSON.stringify(upsertLynxConfig({ locale: raw }), null, 2));
      return;
    }
    console.error(`Unknown config key: ${key}`);
    process.exit(1);
  }
  console.error('Usage: lynx config get | lynx config set <key> <value>');
  process.exit(1);
}
