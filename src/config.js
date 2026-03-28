import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * Load and validate the AIFS configuration from agent-index.json.
 */
export async function loadConfig() {
  const configPath = process.env.AIFS_CONFIG_PATH;
  if (!configPath) {
    throw new Error(
      'AIFS_CONFIG_PATH environment variable is not set. ' +
      'It should point to the agent-index.json file.'
    );
  }

  const resolvedPath = resolve(configPath);
  let raw;
  try {
    raw = await readFile(resolvedPath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read config at ${resolvedPath}: ${err.message}`);
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in config at ${resolvedPath}: ${err.message}`);
  }

  const rf = config.remote_filesystem;
  if (!rf) {
    throw new Error('Config missing "remote_filesystem" section');
  }
  if (!rf.backend) {
    throw new Error('Config missing "remote_filesystem.backend"');
  }
  if (!rf.connection) {
    throw new Error('Config missing "remote_filesystem.connection"');
  }
  if (!rf.auth) {
    throw new Error('Config missing "remote_filesystem.auth"');
  }

  // Resolve credential store path (expand ~)
  const credentialStore = (rf.auth.credential_store || '~/.agent-index/credentials/')
    .replace(/^~/, homedir());

  return {
    backend: rf.backend,
    connection: rf.connection,
    auth: {
      method: rf.auth.method || 'per-member',
      credentialStore,
    },
    mcp_server: rf.mcp_server || {},
    // Pass through the full config for anything adapters might need
    fullConfig: config,
  };
}
