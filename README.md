# agent-index-filesystem

Core framework for the agent-index remote filesystem. Defines the `aifs_*` tool interface, configuration loader, typed errors, and the `BackendAdapter` contract that all storage adapters implement.

The `aifs_*` tools are available as built-in tools in Cowork and can be called directly in exec mode. This package serves as a reference implementation and development foundation for adapter developers — the backend adapter implementations consume this package to implement the `BackendAdapter` contract against their respective storage services.

## What's in This Package

| Module | Purpose |
|---|---|
| `src/config.js` | Loads and validates `agent-index.json` configuration |
| `src/errors.js` | Typed error classes (`FileNotFoundError`, `AccessDeniedError`, etc.) |
| `src/index.js` | Library exports for adapter packages |

## Tool Interface

The `aifs_*` tools are available as built-in tools in Cowork and can be invoked directly in exec mode. As of contract v2.0.0, 14 tools provide the remote filesystem interface (9 core + 5 access-control):

| Tool | Description |
|---|---|
| `aifs_read` | Read file content at a path |
| `aifs_write` | Write content to a path (creates parent directories) |
| `aifs_list` | List directory contents |
| `aifs_exists` | Check if a path exists (lightweight) |
| `aifs_stat` | Get file metadata without reading content |
| `aifs_delete` | Delete a file or empty directory |
| `aifs_copy` | Copy a file within the remote filesystem |
| `aifs_auth_status` | Check current authentication state |
| `aifs_authenticate` | Initiate or complete the authentication flow |
| `aifs_share` | Grant a subject (email or group) a role at a path *(v2.0+)* |
| `aifs_unshare` | Revoke a subject's access at a path *(v2.0+)* |
| `aifs_get_permissions` | List current ACL entries on a path *(v2.0+)* |
| `aifs_transfer_ownership` | Transfer ownership (optional per backend) *(v2.0+)* |
| `aifs_search` | Permission-aware enumeration *(v2.0+)* |

## Backend Adapter Contract

Each adapter implements the `BackendAdapter` interface to provide implementation of the `aifs_*` tools for a specific storage backend:

```typescript
interface BackendAdapter {
  initialize(connection: object, credentialStore: string): Promise<void>;
  getAuthStatus(): Promise<AuthStatus>;
  startAuth(): Promise<AuthStartResult>;
  completeAuth(authCode: string): Promise<AuthCompleteResult>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  list(path: string, recursive: boolean): Promise<DirectoryEntry[]>;
  exists(path: string): Promise<ExistsResult>;
  stat(path: string): Promise<FileMetadata>;
  delete(path: string): Promise<void>;
  copy(source: string, destination: string): Promise<void>;
}
```

## Available Adapters

- [`@agent-index/filesystem-gdrive`](https://github.com/agent-index/agent-index-filesystem-gdrive) — Google Drive
- [`@agent-index/filesystem-onedrive`](https://github.com/agent-index/agent-index-filesystem-onedrive) — Microsoft OneDrive / SharePoint
- [`@agent-index/filesystem-s3`](https://github.com/agent-index/agent-index-filesystem-s3) — Amazon S3

## Related Documentation

- `SPEC.md` — Full `aifs_*` tool interface specification
- `agent-index-meta-docs/filesystem-adapter-spec.md` — Adapter implementation and distribution specification

## License

Proprietary — Copyright (c) 2026 Agent Index Inc. All rights reserved. See [LICENSE](LICENSE) for details.

## Contract Versions

Adapters declare a `contract_version` in `adapter.json`:

- **`1.0.0`** — original 9 ops (read/write/list/exists/stat/delete/copy/auth_status/authenticate). Backwards compatible.
- **`2.0.0`** — adds 5 access-control ops, the `if_revision` parameter on `aifs_write`, and a `revision` field in `aifs_stat` returns. Required for the agent-index-core 3.1.0+ access-control model. The gdrive adapter ships v2.0.0 in package version 2.2.0+; OneDrive and S3 adapters retain v1.0.0 until their own implementations land.

See `SPEC.md` for the full operation specifications.

