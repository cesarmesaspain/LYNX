import {
  readLynxConfig,
  upsertLynxConfig,
  maskApiKey,
  readLynxConfigSafe,
} from '../../config/runtime.js';

export function cmdConfig(args: string[]): void {
  const sub = args[0];

  if (!sub || sub === 'get') {
    console.log(JSON.stringify(readLynxConfigSafe(), null, 2));
    return;
  }

  if (sub === 'set') {
    const key = args[1];
    const raw = args[2];
    if (!key || raw === undefined) {
      console.error(
        'Usage: lynx config set <auto_index|auto_watch|auto_dashboard|auto_index_limit|locale> <value>'
      );
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

  if (sub === 'set-key') {
    const provider = args[1];
    if (!provider) {
      console.error('Usage: lynx config set-key <deepseek|vps> [<key>]');
      console.error('  deepseek:  lynx config set-key deepseek sk-...');
      console.error('  vps:       lynx config set-key vps <url> <key>');
      process.exit(1);
    }
    const cfg = readLynxConfig();
    const keys = { ...cfg.api_keys };
    if (provider === 'deepseek') {
      const key = args[2];
      if (!key) {
        console.error('Usage: lynx config set-key deepseek <api-key>');
        process.exit(1);
      }
      keys.deepseek = key;
    } else if (provider === 'vps') {
      const url = args[2];
      const key = args[3];
      if (!url || !key) {
        console.error('Usage: lynx config set-key vps <url> <api-key>');
        process.exit(1);
      }
      keys.vps_url = url;
      keys.vps_key = key;
    } else {
      console.error(`Unknown provider: ${provider}. Use deepseek or vps.`);
      process.exit(1);
    }
    const updated = upsertLynxConfig({ api_keys: Object.keys(keys).length > 0 ? keys : undefined });
    const masked = updated.api_keys
      ? Object.fromEntries(
          Object.entries(updated.api_keys).map(([k, v]) => [k, v ? maskApiKey(v) : v])
        )
      : undefined;
    console.log(JSON.stringify({ api_keys: masked }, null, 2));
    return;
  }

  if (sub === 'get-key') {
    const cfg = readLynxConfig();
    const keys = cfg.api_keys;
    if (!keys) {
      console.log('No API keys configured.');
      return;
    }
    const masked = Object.fromEntries(
      Object.entries(keys)
        .filter(([, v]) => !!v)
        .map(([k, v]) => [k, v ? maskApiKey(v) : v])
    );
    if (Object.keys(masked).length === 0) {
      console.log('No API keys configured.');
    } else {
      console.log(JSON.stringify(masked, null, 2));
    }
    return;
  }

  if (sub === 'delete-key') {
    const provider = args[1];
    if (!provider) {
      console.error('Usage: lynx config delete-key <deepseek|vps>');
      process.exit(1);
    }
    const cfg = readLynxConfig();
    const keys = { ...cfg.api_keys };
    if (provider === 'deepseek') {
      delete keys.deepseek;
    } else if (provider === 'vps') {
      delete keys.vps_url;
      delete keys.vps_key;
    } else {
      console.error(`Unknown provider: ${provider}. Use deepseek or vps.`);
      process.exit(1);
    }
    upsertLynxConfig({ api_keys: Object.keys(keys).length > 0 ? keys : undefined });
    console.log(`Removed ${provider} API key(s).`);
    return;
  }

  console.error(
    'Usage: lynx config [get] | lynx config set <key> <value> | lynx config set-key <provider> <key> | lynx config get-key [provider] | lynx config delete-key <provider>'
  );
  process.exit(1);
}
