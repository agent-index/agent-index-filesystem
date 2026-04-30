# Agent Index Filesystem — Tool Interface Specification

Version: 2.0.0

## Overview

The Agent Index Filesystem (AIFS) tools provide a backend-agnostic interface for reading and writing files on a remote filesystem. They are available as built-in tools in Cowork and can be called directly in exec mode. The same interface is implemented by backend adapters (Google Drive, OneDrive, S3) to handle the actual storage operations.

This package (`@agent-index/filesystem`) contains the core framework: tool interface definitions, config loader, typed errors, and the `BackendAdapter` contract. It is a development foundation for adapter developers — adapter developers import from it to implement the `BackendAdapter` interface against their respective storage services.

Backend adapters are separate packages that depend on this core:

- `@agent-index/filesystem-gdrive` — Google Drive adapter
- `@agent-index/filesystem-onedrive` — Microsoft OneDrive/SharePoint adapter
- `@agent-index/filesystem-s3` — Amazon S3 adapter

Each adapter provides an implementation of the backend-specific operations. Credentials are stored locally at `.agent-index/credentials/` within the project directory. This location is used because the project directory persists across Cowork sessions (it's mounted from the host), while `~/` is ephemeral within the sandbox. The credential store path is configurable via `auth.credential_store` in `agent-index.json`.

## Configuration

The tools read their configuration from `agent-index.json`, located in the current working directory or specified via environment variable. The tools use the `remote_filesystem` section:

```json
{
  "remote_filesystem": {
    "backend": "gdrive",
    "auth": {
      "method": "per-member",
      "credential_store": ".agent-index/credentials/"
    },
    "connection": { }
  }
}
```

The `connection` object is backend-specific and is used by the adapter implementation. It never contains secrets — only endpoint identifiers (bucket names, drive IDs, OAuth client IDs).

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

Write content to a path on the remote filesystem. Creates parent directories/folders as needed. Overwrites existing files. Supports optional revision-aware writes (v2.0+) for safe concurrent editing of shared state files.

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
    },
    "encoding": {
      "type": "string",
      "enum": ["utf8", "base64"],
      "default": "utf8",
      "description": "Optional. If 'base64', content is decoded to binary before upload."
    },
    "if_revision": {
      "type": "string",
      "description": "Optional (v2.0+). Backend revision identifier from a prior aifs_read or aifs_stat. If supplied, the write is rejected with REVISION_CONFLICT when the file's current revision differs. Used for safe concurrent edits to shared state files (activity-log.jsonl, action-items.json). Callers that omit this parameter get the legacy unconditional-write behavior."
    }
  },
  "required": ["path", "content"]
}
```

**Returns:**
```json
{ "success": true, "path": "/shared/reports/q1.md", "revision": "0BxYz..." }
```

The `revision` field (v2.0+) is the new revision identifier post-write — pass it as `if_revision` on the next write in a read-modify-write cycle. May be `null` for backends without revision identifiers.

**Errors:**
- `ACCESS_DENIED` — Authenticated but lacks write permission
- `NOT_AUTHENTICATED` — No valid credential
- `REVISION_CONFLICT` — `if_revision` was supplied but does not match the file's current revision. Re-read, re-apply, retry. Cap at 5 retries before surfacing.
- `WRITE_CONFLICT` — Conditional write failed at a lower layer (e.g., ETag mismatch unrelated to `if_revision`). Retry with fresh read.
- `BACKEND_ERROR` — Storage backend error

**Backend mapping for `if_revision`:** Drive uses `headRevisionId`; OneDrive uses ETag; S3 uses ETag with `If-Match` on `PutObject` (supported since August 2024). Adapters whose backend has no native conditional-write mechanism must implement application-layer locking or document that they don't support `if_revision`.

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
  "etag": "\"abc123\"",
  "revision": "0BxYz..."
}
```

Fields `created`, `etag`, and `revision` are optional — included when the backend supports them. The `revision` field (v2.0+) is the value to pass as `if_revision` on a subsequent revision-aware write.

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

### aifs_share

Grant a subject (email or group address) a role at a path. Wraps the backend's native ACL system (Drive Permissions API, OneDrive permissions, S3 IAM/bucket policy). All ACL changes execute under the calling member's OAuth identity — adapters must not elevate privilege.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Path of the resource to share. For folders, the share is applied at folder level and inheritance covers descendants by default."
    },
    "subject": {
      "type": "string",
      "description": "Email address (individual) or group address (e.g., a Google Group). Adapters translate to backend-native identity."
    },
    "role": {
      "type": "string",
      "enum": ["reader", "commenter", "writer"],
      "description": "Backend-agnostic role. Adapters map to native role: Drive (reader/commenter/writer), OneDrive (read/write — commenter maps to read), S3 (corresponding IAM actions). Adapters that don't support 'commenter' map it to the closest equivalent and document the mapping."
    },
    "inherit": {
      "type": "boolean",
      "description": "Optional. Default true. When false, the share is applied as an explicit override that takes precedence over parent-folder inheritance — the subject sees ONLY this resource, not the parent. Used for path-B initial member directories and Phase-5 scoped-idea ACLs.",
      "default": true
    }
  },
  "required": ["path", "subject", "role"]
}
```

**Returns:**
```json
{
  "shared": true,
  "permission_id": "anyqAJyJK1wjz5tYDGYdkM3JL5jJSSCExm0OwSBpcg8",
  "path": "/shared/projects/foo/"
}
```

The `permission_id` is the backend-native handle for the grant. May be `null` for backends without persistent permission identifiers.

**Errors:**
- `ACCESS_DENIED` — Authenticated but lacks permission to share this resource
- `INVALID_SUBJECT` — The `subject` is not a valid email or group address recognized by the backend
- `INVALID_ROLE` — The `role` value is not accepted, or the backend does not support it at this path
- `NOT_AUTHENTICATED` — No valid credential
- `PATH_NOT_FOUND` — The resource at `path` does not exist
- `BACKEND_ERROR` — Storage backend error

---

### aifs_unshare

Revoke a subject's access at a path. Symmetric inverse of `aifs_share`. Removes the explicit grant; inherited grants from parent folders persist unless they are also unshared.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "Path of the resource." },
    "subject": { "type": "string", "description": "Email or group address whose access should be revoked." }
  },
  "required": ["path", "subject"]
}
```

**Returns:**
```json
{ "unshared": true, "path": "/shared/projects/foo/" }
```

The `unshared` field is `false` if the subject had no explicit grant on this exact path (e.g., they had inherited access only). This is not an error — the recommended pattern is to surface it as a soft outcome.

**Errors:**
- `ACCESS_DENIED` — Authenticated but lacks permission to revoke shares on this resource
- `NOT_AUTHENTICATED` — No valid credential
- `PATH_NOT_FOUND` — The resource at `path` does not exist
- `BACKEND_ERROR` — Storage backend error

---

### aifs_get_permissions

List current permissions at a path. Returns explicit grants on the resource and, optionally, inherited grants from ancestors.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "Path of the resource." },
    "include_inherited": {
      "type": "boolean",
      "description": "Optional. Default true. If false, only explicit grants on this exact path are returned.",
      "default": true
    }
  },
  "required": ["path"]
}
```

**Returns:**
```json
{
  "permissions": [
    {
      "subject": "bill@agent-index.ai",
      "role": "writer",
      "permission_id": "anyqAJyJK1wjz5tYDGYdkM3JL5jJSSCExm0OwSBpcg8",
      "inherited_from": null,
      "granted_date": "2026-04-29T20:00:00Z"
    },
    {
      "subject": "agent-index-all@brainly.com",
      "role": "reader",
      "permission_id": "byrAB...",
      "inherited_from": "/",
      "granted_date": "2026-04-15T10:00:00Z"
    }
  ]
}
```

The `inherited_from` field is `null` for explicit grants on this path; for inherited grants it carries the path of the ancestor that owns the grant.

**Errors:**
- `ACCESS_DENIED` — Lacks permission to inspect ACLs on this resource
- `NOT_AUTHENTICATED` — No valid credential
- `PATH_NOT_FOUND` — The resource at `path` does not exist
- `BACKEND_ERROR` — Storage backend error

---

### aifs_transfer_ownership

Transfer ownership of a path (and its contents) to a new owner. Used during member offboarding when content should be retained but the original owner is leaving the org. **Optional operation** — adapters whose backend has no concept of transferable ownership may omit this op and return `NOT_IMPLEMENTED`.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "Path of the resource." },
    "new_owner": {
      "type": "string",
      "description": "Email address of the new owner. Must be a valid identity in the backend (typically a Workspace user or admin)."
    }
  },
  "required": ["path", "new_owner"]
}
```

**Returns:**
```json
{ "transferred": true, "path": "/members/abc1234.../", "new_owner": "admin@brainly.com" }
```

**Errors:**
- `ACCESS_DENIED` — Caller is not the current owner and not authorized to transfer
- `NOT_AUTHENTICATED` — No valid credential
- `PATH_NOT_FOUND` — The resource at `path` does not exist
- `INVALID_RECIPIENT` — `new_owner` is not a valid identity, or is outside the workspace where transfer is permitted
- `NOT_IMPLEMENTED` — This adapter does not support ownership transfer (legitimate response for backends without an ownership concept)
- `BACKEND_ERROR` — Storage backend error

**Backend notes:**
- Google Drive: `permissions.update` with `transferOwnership=true`. Both old and new owners must be in the same Workspace. Some file types (e.g., shortcuts) may not be transferable.
- OneDrive: ownership is implicit per drive; transfer-equivalent is moving content to a new drive. May implement as copy + delete, or return `NOT_IMPLEMENTED`.
- S3: bucket owner is fixed; should return `NOT_IMPLEMENTED`.

---

### aifs_search

Permission-aware enumeration. Returns resources the caller has access to under a given scope. Replaces enumeration patterns that would otherwise require a central manifest. Implementations leverage the backend's native search/list APIs (Drive `files.list?q=`, OneDrive `search`, S3 `ListObjectsV2` with prefix); permission-awareness comes naturally — every backend already returns only what the calling identity can see.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "scope": { "type": "string", "description": "Path prefix to search under. Use '/' to search the entire filesystem the caller can see." },
    "type": {
      "type": "string",
      "enum": ["folder", "file", "any"],
      "default": "any",
      "description": "Optional. Filter by resource type."
    },
    "name_contains": { "type": "string", "description": "Optional. Substring match on resource name (case-insensitive)." },
    "max_results": { "type": "integer", "default": 100, "description": "Optional. Cap on returned results. Adapters may impose their own caps regardless." }
  },
  "required": ["scope"]
}
```

**Returns:**
```json
{
  "results": [
    {
      "path": "/shared/projects/pricing-refresh/",
      "type": "folder",
      "name": "pricing-refresh",
      "owner": "bill@agent-index.ai",
      "modified": "2026-04-29T18:00:00Z"
    }
  ],
  "truncated": false
}
```

The `truncated` field indicates whether the result set was capped. When `truncated: true`, the caller should narrow the query.

**Errors:**
- `ACCESS_DENIED` — Caller has no read permission anywhere under `scope` (rare — typically search returns empty results rather than erroring)
- `NOT_AUTHENTICATED` — No valid credential
- `INVALID_SCOPE` — `scope` is malformed or refers to a non-folder path
- `BACKEND_ERROR` — Storage backend error

**Query-language portability:** The minimal portable query language is `(scope, type, name_contains)`. Backends with richer query syntax may support additional filtering through future SPEC versions, but no consumer collection should rely on backend-specific features.

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

Credentials are stored as JSON at `{credential_store}/{backend}.json` (e.g., `.agent-index/credentials/gdrive.json` relative to the project root). The file contains the full token set: `access_token`, `refresh_token`, `expiry_date`, `token_type`, and any backend-specific fields.

### Silent Token Refresh

Access tokens are short-lived (typically 1 hour for Google). Adapters must handle refresh transparently:

1. **Library-level auto-refresh:** The OAuth client library (e.g., `google-auth-library`) automatically refreshes expired access tokens when a valid refresh token is present. Adapters should enable this by setting credentials on the client during initialization.

2. **Persistence on refresh:** Adapters must listen for token refresh events (e.g., the `tokens` event on Google's `OAuth2Client`) and write the new tokens to the credential file immediately. This ensures refreshed tokens are available to subsequent invocations. The listener must merge new tokens with existing ones to preserve the refresh token (refresh events may only include the new access token and expiry).

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

Each backend adapter must implement the following interface. **Contract version 2.0** adds five access-control methods, a `search` method, and an `ifRevision` parameter to `write`. Adapters declare which contract version they implement via the `contractVersion` field on their adapter manifest.

```typescript
interface BackendAdapter {
  // Lifecycle
  initialize(connection: object, credentialStore: string): Promise<void>;

  // Contract metadata
  readonly contractVersion: string;     // e.g., "2.0.0"

  // Auth
  getAuthStatus(): Promise<AuthStatus>;
  startAuth(): Promise<AuthStartResult>;
  completeAuth(authCode: string): Promise<AuthCompleteResult>;

  // File operations (v2.0: write returns revision; stat includes revision)
  read(path: string): Promise<{ content: string; revision: string | null }>;
  write(path: string, content: string, options?: WriteOptions): Promise<{ revision: string | null }>;
  list(path: string, recursive: boolean): Promise<DirectoryEntry[]>;
  exists(path: string): Promise<ExistsResult>;
  stat(path: string): Promise<FileMetadata>;     // FileMetadata includes `revision` in v2.0
  delete(path: string): Promise<void>;
  copy(source: string, destination: string): Promise<void>;

  // Search (v2.0+)
  search(query: SearchQuery): Promise<SearchResult>;

  // Access control (v2.0+)
  share(path: string, subject: string, role: Role, options?: ShareOptions): Promise<ShareResult>;
  unshare(path: string, subject: string): Promise<{ unshared: boolean }>;
  getPermissions(path: string, options?: GetPermissionsOptions): Promise<PermissionList>;

  // Optional. Adapters whose backend has no transferable ownership omit this method entirely.
  transferOwnership?(path: string, newOwner: string): Promise<TransferResult>;
}

interface WriteOptions {
  ifRevision?: string;     // Reject with REVISION_CONFLICT if current revision differs.
  encoding?: 'utf8' | 'base64';
}

interface SearchQuery {
  scope: string;
  type?: 'folder' | 'file' | 'any';
  nameContains?: string;
  maxResults?: number;
}

interface SearchResult {
  results: Array<{ path: string; type: 'folder' | 'file'; name: string; owner?: string; modified?: string }>;
  truncated: boolean;
}

type Role = 'reader' | 'commenter' | 'writer';

interface ShareOptions {
  inherit?: boolean;     // Default true; false applies as explicit override below parent inheritance
}

interface ShareResult {
  shared: boolean;
  permissionId: string | null;
}

interface GetPermissionsOptions {
  includeInherited?: boolean;     // Default true
}

interface PermissionList {
  permissions: Array<{
    subject: string;
    role: Role;
    permissionId: string | null;
    inheritedFrom: string | null;
    grantedDate: string | null;
  }>;
}

interface TransferResult {
  transferred: boolean;
}
```

Adapters throw typed errors (e.g., `FileNotFoundError`, `NotAuthenticatedError`, `RevisionConflictError`, `InvalidSubjectError`, `NotImplementedError`) which the executor translates into the standard error response format.

### Adapter Manifest

Each adapter package's `adapter.json` declares the contract version it implements and which optional methods it supports:

```json
{
  "adapter": "gdrive",
  "version": "2.0.0",
  "contractVersion": "2.0.0",
  "supportedOperations": [
    "read", "write", "list", "exists", "stat", "delete", "copy",
    "search",
    "share", "unshare", "getPermissions", "transferOwnership"
  ],
  "writeSupportsIfRevision": true
}
```

Adapters that ship a partial v2.0 implementation (e.g., not yet implementing `share`/`unshare`) declare `contractVersion: "1.0.0"` and let consumers know not to call the missing ops. The executor uses the manifest to surface clear `NOT_IMPLEMENTED` errors when a consumer attempts an unsupported op rather than letting the call fail mysteriously inside the adapter.


### Additional Adapter Requirements

**OAuth callback server (OAuth-based adapters):** `startAuth()` should attempt to start a temporary HTTP server on `127.0.0.1:3939` to capture the OAuth redirect callback automatically. If the port is unavailable, fall back to returning `status: "awaiting_code"` with instructions for manual code entry. The callback server should auto-shutdown after 5 minutes or after capturing a code (whichever comes first).

**Token refresh persistence (OAuth-based adapters):** `initialize()` must set up a listener for token refresh events and persist refreshed tokens to the credential file. See the Token Management section above.

**401 auto-retry:** All backend API calls must be wrapped with retry logic that catches 401 (unauthorized) errors, attempts a token refresh, and retries the operation once. This is transparent to the caller.

**Specific error detection in `completeAuth()`:** When the token exchange fails, detect specific error types and throw `AuthFailedError` with appropriate details:
- `invalid_grant` (expired or already-used auth code) → `{ retryable: true }`
- `redirect_uri_mismatch` (configuration error) → `{ retryable: false }`
- Other errors → generic `AuthFailedError` with the backend's error message
