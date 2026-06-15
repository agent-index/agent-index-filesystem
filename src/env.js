import { existsSync } from 'node:fs';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

/**
 * Auto-detect proxy environment and configure Node.js TLS accordingly.
 *
 * Many MCP hosting environments (Cowork, sandboxed VMs) route outbound
 * traffic through an HTTP proxy that performs TLS interception (MITM).
 * Node.js respects HTTP_PROXY/HTTPS_PROXY for some clients, but does NOT
 * automatically trust the proxy's CA certificate — causing TLS failures
 * for every outbound HTTPS request.
 *
 * This function detects the proxy environment and, if a known MITM CA
 * certificate is present, adds it to Node's trusted CA list. It is a
 * no-op when no proxy is detected.
 *
 * Call this BEFORE initializing any HTTP clients (Google APIs, Azure, AWS).
 */

// Well-known paths where proxy MITM CA certificates may be installed.
const KNOWN_CA_PATHS = [
  '/usr/local/share/ca-certificates/mitm-proxy-ca.crt',
  '/etc/ssl/certs/mitm-proxy-ca.pem',
  '/etc/pki/ca-trust/source/anchors/mitm-proxy-ca.crt',
];

let _initialized = false;

export function initEnvironment() {
  if (_initialized) return;
  _initialized = true;

  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!httpsProxy) {
    // No proxy — nothing to configure.
    return;
  }

  // Resolve the MITM CA certificate (content), if we need to trust one.
  // When NODE_EXTRA_CA_CERTS is set, Node's TLS already trusts it globally and
  // undici's default secure context picks it up — so we leave caCert null and
  // use the default-TLS proxy dispatcher below.
  let caCert = null;
  let caSource = null;
  if (!process.env.NODE_EXTRA_CA_CERTS) {
    const customCaPath = process.env.AIFS_CA_CERT;
    if (customCaPath && !existsSync(customCaPath)) {
      console.warn(`[aifs] AIFS_CA_CERT set to ${customCaPath} but file not found — skipping.`);
    }
    const candidates = customCaPath ? [customCaPath] : KNOWN_CA_PATHS;
    for (const p of candidates) {
      if (existsSync(p)) {
        try { caCert = readFileSync(p, 'utf-8'); caSource = p; break; } catch { /* try next */ }
      }
    }
  }

  // (1) Node https/tls clients (google-auth-library / gaxios, etc.) honor
  //     HTTPS_PROXY themselves; they just need the MITM CA trusted.
  if (caCert) _addCaCert(caCert, caSource);

  // (2) undici global fetch (the OneDrive adapter and any fetch-based backend)
  //     does NOT honor HTTPS_PROXY on its own AND does not pick up the
  //     createSecureContext patch above — so it needs an explicit proxy
  //     dispatcher, with the MITM CA threaded into requestTls. Without this,
  //     every fetch dies (EAI_AGAIN / "fetch failed") in a proxied sandbox.
  //     Validated 2026-06-14 in a live proxied sandbox (bug 20260614-…-odproxy).
  try {
    // requestTls.ca REPLACES the trust store, so pass the COMBINED set
    // (default roots + MITM) — passing the MITM cert alone breaks normal chains.
    const opts = caCert ? { requestTls: { ca: [...tls.rootCertificates, caCert] } } : {};
    setGlobalDispatcher(new EnvHttpProxyAgent(opts));
    // stderr, NOT stdout — exec mode writes byte-exact file content to stdout,
    // so any diagnostic on stdout corrupts aifs_read in proxied sandboxes
    // (bug 20260615-8d20ea22-stdoutlog).
    console.error(
      `[aifs] Proxy detected — fetch routed through HTTPS_PROXY` +
      (caCert ? ` (MITM CA trusted from ${caSource})` : '')
    );
  } catch (err) {
    console.warn(`[aifs] Could not configure proxy dispatcher for fetch: ${err.message}`);
  }

  if (!caCert && !process.env.NODE_EXTRA_CA_CERTS) {
    console.warn(
      '[aifs] HTTPS_PROXY is set but no MITM CA certificate found. ' +
      'If TLS errors occur, set AIFS_CA_CERT or NODE_EXTRA_CA_CERTS to the proxy CA path.'
    );
  }
}

/**
 * Add a CA certificate (PEM content) to Node's default TLS trust store at
 * runtime, for Node https/tls-based clients. Equivalent to NODE_EXTRA_CA_CERTS
 * but applied after process startup. (undici fetch is handled separately via
 * the proxy dispatcher in initEnvironment.)
 */
function _addCaCert(cert, source = 'configured path') {
  try {
    // Append to the default CA list rather than replacing it.
    const combined = [...tls.rootCertificates, cert];

    tls.createSecureContext = ((original) => {
      return function (options = {}) {
        if (!options.ca) {
          options = { ...options, ca: combined };
        }
        return original(options);
      };
    })(tls.createSecureContext);

    console.error(`[aifs] Proxy detected — added CA certificate from ${source}`);  // stderr — keep stdout clean for byte-exact reads
  } catch (err) {
    console.warn(`[aifs] Failed to apply CA certificate from ${source}: ${err.message}`);
  }
}
