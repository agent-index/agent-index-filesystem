# Agent Index Filesystem — MCP Server Interface Specification

Version: 1.0.0

## Overview

The Agent Index Filesystem (AIFS) MCP server provides a backend-agnostic interface for reading and writing files on a remote filesystem. It exposes a fixed set of tools that Claude calls through the MCP protocol. Each backend adapter (Google Drive, OneDrive, S3) implements these tools using the appropriate storage API.

This package (`@agent-index/filesystem`) contains the core framework: MCP server, tool definitions, config loader, and typed errors. It is a development dependency only — adapter developers import from it, and the bundler compiles it into the adapter's self-contained `dist/server.bundle.js`. This package is never distributed to end users.

Backend adapters are separate packages that depend on this core:

- `@agent-index/filesystem-gdrive` — Google Drive adapter
- `@agent-index/filesystem-onedrive` — Microsoft OneDrive/SharePoint adapter
- `@agent-index/filesystem-s3` — Amazon S3 adapter

Each adapter is built into a single-file bundle that includes this core, the backend SDK, and all transitive dependencies. The bundle is committed to the adapter repo at `dist/server.bundle.js` and shipped to members inside the bootstrap zip. See `filesystem-adapter-spec.md` in `agent-index-meta-docs` for the full adapter packaging and distribution specification.

The MCP server runs locally on each member's machine as a child process of Cowork. It authenticates to the remote storage backend using per-member credentials stored at `~/.agent-index/credentials/`.

## Configuration

The MCP server reads its configuration from `agent-index.json`, located via the `AIFS_CONFIG_PATH` environment variable. It uses the `remote_filesystem` section:

```json
{
  "remote_filesystem": {
    "backend": "gdrive",
    "mcp_server": {
      "adapter": "gdrive",
      "adapter_version": "1.0.0",
      "bundle_path": "mcp-servers/filesystem/server.bundle.js"
    },
    "auth": {
      "method": "per-member",
      "credential_store": "~/.agent-index/credentials/"
    },
    "connection": { }
  }
}
```

The `connection` object is backend-specific and is passed directly to the backend adapter. It never contains secrets — only endpoint identifiers (bucket names, drive IDs, OAuth client IDs).

## Tool Definitions

### aifs_read

Read file content at a path on the remote filesystem.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Path relative to remote filesystem root (e.g., '/org-config.json', '/shared/reports/q1.md')"
    }
  },
  "required": ["path"]
}
```

**Returns:** File content as a string (UTF-8 text files) or base64-encoded string with a `base64:` prefix (binary files).

**Errors:**
- `FILE_NOT_FOUND` — No file exists at the given path
- `ACCESS_DENIED` — Authenticated but lacks permission to read this file
- `NOT_AUTHENTICATED` — No valid credential; member must authenticate
- `BACKEND_ERROR` — Storage backend returned an unexpected error (details in message)

---

### aifs_write

Write content to a path on the remote filesystem. Creates parent directories/folders as needed. Overwrites existing files.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Path relative to remote filesystem root"
    },
    "content": {
      "type": "string",
      "description": "File content to write (UTF-8 text, or base64-encoded with 'base64:' prefix for binary)"
    }
  },
  "required": ["path", "content"]
}
```

**Returns:**
```json
{ "success": true, "path": "/shared/reports/q1.md" }
```

**Errors:**
- `ACCESS_DENIED` — Authenticated but lacks write permission
- `NOT_AUTHENTICATED` — No valid credential
- `WRITE_CONFLICT` — Conditional write failed (e.g., ETag mismatch). Retry with fresh read.
- `BACKEND_ERROR` — Storage backend error

---

### aifs_list

List directory contents at a path on the remote filesystem.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Directory path relative to remote filesystem root"
    },
    "recursive": {
      "type": "boolean",
      "description": "If true, return full subtree. Use sparingly on large directories.",
      "default": false
    }
  },
  "required": ["path"]
}
```

**Returns:**
```json
{
  "entries": [
    { "name": "org-config.json", "type": "file", "size": 1024, "modified": "2026-03-24T10:00:00Z" },
    { "name": "shared", "type": "directory" },
    { "name": "agent-index-core", "type": "directory" }
  ]
}
```

**Errors:**
- `PATH_NOT_FOUND` — No directory exists at the given path
- `ACCESS_DENIED` — Lacks permission to list this directory
- `NOT_AUTHENTICATED` — No valid credential
- `BACKEND_ERROR` — Storage backend error

---

### aifs_exists

Check whether a path exists without reading its content. Lightweight — preferred over `aifs_read` when you only need existence.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Path to check"
    }
  },
  "required": ["path"]
}
```

**Returns:**
```json
{ "exists": true, "type": "file" }
```
or
```json
{ "exists": false }
```

**Errors:**
- `NOT_AUTHENTICATED` — No valid credential
- `BACKEND_ERROR` — Storage backend error

---

### aifs_stat

Get file metadata without reading content. Used for staleness checks and conditional operations.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Path to get metadata for"
    }
  },
  "required": ["path"]
}
```

**Returns:**
```json
{
  "size": 1024,
  "modified": "2026-03-24T10:00:00Z",
  "created": "2026-03-20T08:00:00Z",
  "etag": "\"abc123\""
}
```

Fields `created` and `etag` are optional — included when the backend supports them.

**Errors:**
- `FILE_NOT_FOUND` — No file at this path
- `NOT_AUTHENTICATED` — No valid credential
- `BACKEND_ERROR` — Storage backend error

---

### aifs_delete

Delete a file or empty directory.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Path to delete"
    }
  },
  "required": ["path"]
}
```

**Returns:**
```json
{ "success": true }
```

**Errors:**
- `FILE_NOT_FOUND` — Nothing exists at this path
- `ACCESS_DENIED` — Lacks delete permission
- `NOT_EMPTY` — Attempted to delete a non-empty directory
- `NOT_AUTHENTICATED` — No valid credential
- `BACKEND_ERROR` — Storage backend error

---

### aifs_copy

Copy a file within the remote filesystem.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "source": {
      "type": "string",
      "description": "Source path"
    },
    "destination": {
      "type": "string",
      "description": "Destination path"
    }
  },
  "required": ["source", "destination"]
}
```

**Returns:**
```json
{ "success": true }
```

**Errors:**
- `FILE_NOT_FOUND` — Source does not exist
- `ACCESS_DENIED` — Lacks permission
- `NOT_AUTHENTICATED` — No valid credential
- `BACKEND_ERROR` — Storage backend error

---

### aifs_auth_status

Check the current authentication state. Always succeeds — returns auth state without requiring auth.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {},
  "required": []
}
```

**Returns:**
```json
{
  "authenticated": true,
  "backend": "gdrive",
  "user_identity": "bill@agent-index.ai",
  "expires_at": "2026-03-24T11:00:00Z"
}
```
or
```json
{
  "authenticated": false,
  "backend": "gdrive",
  "reason": "no_credential"
}
```

Possible `reason` values when not authenticated: `no_credential`, `expired`, `revoked`, `invalid`.

---

### aifs_authenticate

Initiate or complete the authentication flow. Backend-specific.

For OAuth-based backends (Google Drive, OneDrive), the `start` action attempts to launch a temporary HTTP callback server on `127.0.0.1:3939` to automatically capture the authorization code from the OAuth redirect. If the port is available, the callback is handled transparently and the user sees a "success" page in their browser. If the port is unavailable, the adapter falls back to manual code entry.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": ["start", "complete"],
      "description": "'start' initiates the auth flow and returns instructions. 'complete' finishes it (e.g., with an auth code).",
      "default": "start"
    },
    "auth_code": {
      "type": "string",
      "description": "Authorization code from OAuth callback (used with action='complete'). Optional if the callback server captured the code automatically."
    }
  },
  "required": []
}
```

**Returns (action=start):**

If the callback server started successfully:
```json
{
  "status": "awaiting_callback",
  "auth_url": "https://accounts.google.com/o/oauth2/v2/auth?client_id=...",
  "message": "Open this URL in your browser and sign in. After granting access, you'll see a success page and can return here."
}
```

If the callback server could not start (port unavailable):
```json
{
  "status": "awaiting_code",
  "auth_url": "https://accounts.google.com/o/oauth2/v2/auth?client_id=...",
  "message": "Open this URL in your browser, sign in, and paste the authorization code here."
}
```

The `status` field tells the caller how to handle `action=complete`: if `awaiting_callback`, the code was captured automatically and `auth_code` can be omitted. If `awaiting_code`, the user must paste the code manually.

**Returns (action=complete):**
```json
{
  "status": "authenticated",
  "user_identity": "bill@agent-index.ai",
  "message": "Successfully authenticated to Google Drive."
}
```

**Errors:**
- `AUTH_FAILED` — The auth flow failed. Check error details:
  - `retryable: true` — The authorization code expired or was already used (`invalid_grant`). Generate a fresh code by calling `start` again.
  - `retryable: false` — A configuration error like `redirect_uri_mismatch`. Requires manual fix before retrying.
  - No `retryable` field — Generic auth failure. Details in the message.
- `BACKEND_ERROR` — Could not reach the auth provider

---

## Error Response Format

All errors are returned as MCP tool errors with a structured JSON message:

```json
{
  "error": "FILE_NOT_FOUND",
  "message": "No file exists at path: /org-config.json",
  "path": "/org-config.json"
}
```

The `error` field is a machine-readable code from the error sets defined above. The `message` field is human-readable. Additional fields (like `path`) provide context.

For `AUTH_FAILED` errors, the response may include a `retryable` boolean:
```json
{
  "error": "AUTH_FAILED",
  "message": "The authorization code has expired or was already used.",
  "retryable": true
}
```

## Token Management

OAuth-based adapters (Google Drive, OneDrive) must handle token lifecycle transparently so that members never encounter auth prompts during normal use after their initial setup.

### Token Storage

Credentials are stored as JSON at `{credential_store}/{backend}.json` (e.g., `~/.agent-index/credentials/gdrive.json`). The file contains the full token set: `access_token`, `refresh_token`, `expiry_date`, `token_type`, and any backend-specific fields.

### Silent Token Refresh

Access tokens are short-lived (typically 1 hour for Google). Adapters must handle refresh transparently:

1. **Library-level auto-refresh:** The OAuth client library (e.g., `google-auth-library`) automatically refreshes expired access tokens when a valid refresh token is present. Adapters should enable this by setting credentials on the client during initialization.

2. **Persistence on refresh:** Adapters must listen for token refresh events (e.g., the `tokens` event on Google's `OAuth2Client`) and write the new tokens to the credential file immediately. This ensures refreshed tokens survive MCP server restarts. The listener must merge new tokens with existing ones to preserve the refresh token (refresh events may only include the new access token and expiry).

3. **Retry on 401:** Despite library-level auto-refresh, edge cases (race conditions, clock skew, stale cached tokens) can produce 401 errors. Adapters must wrap all backend API calls with a retry mechanism that catches 401 errors, attempts a manual token refresh, and retries the operation exactly once. If the retry also fails, the error propagates.

### Refresh Token Validity

Refresh tokens are long-lived but can be revoked by the user, the admin, or the identity provider. When a refresh token is invalid, the adapter should throw `NotAuthenticatedError('expired')`, which signals Claude to guide the member through re-authentication via `aifs_authenticate`.

For Google OAuth apps in "testing" status (not verified), refresh tokens expire after 7 days. Production-verified apps have indefinite refresh tokens. Admins should verify their OAuth app to avoid weekly re-authentication.

## Path Conventions

- All paths are relative to the remote filesystem root
- Paths use forward slashes regardless of backend
- Paths start with `/`
- No trailing slashes on directory paths
- The root path is `/`
- Backend adapters handle mapping logical paths to backend-native identifiers (e.g., Google Drive file IDs, S3 object keys)

## Backend Adapter Contract

Each backend adapter must implement the following interface:

```typescript
interface BackendAdapter {
  // Lifecycle
  initialize(connection: object, credentialStore: string): Promise<void>;

  // Auth
  getAuthStatus(): Promise<AuthStatus>;
  startAuth(): Promise<AuthStartResult>;
  completeAuth(authCode: string): Promise<AuthCompleteResult>;

  // File operations
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  list(path: string, recursive: boolean): Promise<DirectoryEntry[]>;
  exists(path: string): Promise<ExistsResult>;
  stat(path: string): Promise<FileMetadata>;
  delete(path: string): Promise<void>;
  copy(source: string, destination: string): Promise<void>;
}
```

Adapters throw typed errors (e.g., `FileNotFoundError`, `NotAuthenticatedError`) which the MCP server translates into the standard error response format.

### Additional Adapter Requirements

**OAuth callback server (OAuth-based adapters):** `startAuth()` should attempt to start a temporary HTTP server on `127.0.0.1:3939` to capture the OAuth redirect callback automatically. If the port is unavailable, fall back to returning `status: "awaiting_code"` with instructions for manual code entry. The callback server should auto-shutdown after 5 minutes or after capturing a code (whichever comes first).

**Token refresh persistence (OAuth-based adapters):** `initialize()` must set up a listener for token refresh events and persist refreshed tokens to the credential file. See the Token Management section above.

**401 auto-retry:** All backend API calls must be wrapped with retry logic that catches 401 (unauthorized) errors, attempts a token refresh, and retries the operation once. This is transparent to the caller.

**Specific error detection in `completeAuth()`:** When the token exchange fails, detect specific error types and throw `AuthFailedError` with appropriate details:
- `invalid_grant` (expired or already-used auth code) → `{ retryable: true }`
- `redirect_uri_mismatch` (configuration error) → `{ retryable: false }`
- Other errors → generic `AuthFailedError` with the backend's error message
