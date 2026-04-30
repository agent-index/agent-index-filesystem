/**
 * @agent-index/filesystem — Core MCP server for the Agent Index remote filesystem.
 *
 * This package provides the backend-agnostic MCP server, tool definitions,
 * config loader, and typed error classes. Backend adapters (Google Drive,
 * OneDrive, S3) import from this package and provide their own entry point.
 *
 * Usage from an adapter package:
 *
 *   import { loadConfig, startServer } from '@agent-index/filesystem';
 *   import { MyAdapter } from './adapters/my-adapter.js';
 *
 *   const config = await loadConfig();
 *   const adapter = new MyAdapter();
 *   await adapter.initialize(config.connection, config.auth.credentialStore);
 *   await startServer(adapter, config);
 */

export { initEnvironment } from './env.js';
export { testDomainReachability, testAllDomains } from './network.js';
export { loadConfig } from './config.js';
export { createServer, startServer } from './server.js';
export {
  AifsError,
  FileNotFoundError,
  PathNotFoundError,
  AccessDeniedError,
  NotAuthenticatedError,
  WriteConflictError,
  NotEmptyError,
  AuthFailedError,
  BackendError,
} from './errors.js';
