import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { AifsError } from './errors.js';

/**
 * Tool definitions for the AIFS MCP server.
 * These are backend-agnostic — the same regardless of which adapter is used.
 */
const TOOLS = [
  {
    name: 'aifs_read',
    description: 'Read file content at a path on the remote filesystem.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to remote filesystem root (e.g., "/org-config.json")',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'aifs_write',
    description: 'Write content to a path on the remote filesystem. Creates parent directories as needed.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to remote filesystem root',
        },
        content: {
          type: 'string',
          description: 'File content (UTF-8 text, or base64-encoded with "base64:" prefix for binary)',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'aifs_list',
    description: 'List directory contents at a path on the remote filesystem.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to remote filesystem root',
        },
        recursive: {
          type: 'boolean',
          description: 'If true, return full subtree. Use sparingly.',
          default: false,
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'aifs_exists',
    description: 'Check whether a path exists without reading content. Lightweight.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to check',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'aifs_stat',
    description: 'Get file metadata (size, modified date) without reading content.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to get metadata for',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'aifs_delete',
    description: 'Delete a file or empty directory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to delete',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'aifs_copy',
    description: 'Copy a file within the remote filesystem.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Source path',
        },
        destination: {
          type: 'string',
          description: 'Destination path',
        },
      },
      required: ['source', 'destination'],
    },
  },
  {
    name: 'aifs_auth_status',
    description: 'Check current authentication state. Always succeeds.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'aifs_authenticate',
    description: 'Initiate or complete authentication to the remote filesystem.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'complete'],
          description: '"start" initiates auth and returns instructions. "complete" finishes with an auth code.',
          default: 'start',
        },
        auth_code: {
          type: 'string',
          description: 'Authorization code from OAuth callback (used with action="complete")',
        },
      },
      required: [],
    },
  },
];

/**
 * Create and configure the AIFS MCP server.
 *
 * @param {object} adapter - Backend adapter instance implementing the adapter interface
 * @param {object} config - Parsed AIFS configuration
 * @returns {Server} Configured MCP server
 */
export function createServer(adapter, config) {
  const server = new Server(
    {
      name: 'agent-index-filesystem',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await routeToolCall(adapter, name, args || {});
      return {
        content: [
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      if (err instanceof AifsError) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(err.toResponse(), null, 2),
            },
          ],
          isError: true,
        };
      }
      // Unexpected error — wrap it
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'BACKEND_ERROR',
              message: err.message,
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Route a tool call to the appropriate adapter method.
 */
async function routeToolCall(adapter, toolName, args) {
  switch (toolName) {
    case 'aifs_read':
      return adapter.read(args.path);

    case 'aifs_write': {
      await adapter.write(args.path, args.content);
      return { success: true, path: args.path };
    }

    case 'aifs_list': {
      const entries = await adapter.list(args.path, args.recursive ?? false);
      return { entries };
    }

    case 'aifs_exists':
      return adapter.exists(args.path);

    case 'aifs_stat':
      return adapter.stat(args.path);

    case 'aifs_delete': {
      await adapter.delete(args.path);
      return { success: true };
    }

    case 'aifs_copy': {
      await adapter.copy(args.source, args.destination);
      return { success: true };
    }

    case 'aifs_auth_status':
      return adapter.getAuthStatus();

    case 'aifs_authenticate': {
      const action = args.action || 'start';
      if (action === 'start') {
        return adapter.startAuth();
      } else if (action === 'complete') {
        return adapter.completeAuth(args.auth_code);
      }
      throw new AifsError('BACKEND_ERROR', `Unknown auth action: ${action}`);
    }

    default:
      throw new AifsError('BACKEND_ERROR', `Unknown tool: ${toolName}`);
  }
}

/**
 * Start the MCP server with stdio transport.
 */
export async function startServer(adapter, config) {
  const server = createServer(adapter, config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
