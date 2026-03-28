import { existsSync } from 'node:fs';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';

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

  // If NODE_EXTRA_CA_CERTS is already set, the user/platform handled it.
  if (process.env.NODE_EXTRA_CA_CERTS) {
    return;
  }

  // Check for a custom override first.
  const customCaPath = process.env.AIFS_CA_CERT;
  if (customCaPath) {
    if (existsSync(customCaPath)) {
      _addCaCert(customCaPath);
      return;
    }
    console.warn(`[aifs] AIFS_CA_CERT set to ${customCaPath} but file not found — skipping.`);
    return;
  }

  // Probe well-known paths.
  for (const caPath of KNOWN_CA_PATHS) {
    if (existsSync(caPath)) {
      _addCaCert(caPath);
      return;
    }
  }

  // Proxy detected but no MITM CA found. This may be fine (not all proxies
  // do TLS interception), but log a note in case requests fail later.
  console.warn(
    '[aifs] HTTPS_PROXY is set but no MITM CA certificate found. ' +
    'If TLS errors occur, set AIFS_CA_CERT or NODE_EXTRA_CA_CERTS to the proxy CA path.'
  );
}

/**
 * Add a CA certificate to Node's default TLS trust store at runtime.
 * This is equivalent to setting NODE_EXTRA_CA_CERTS but works after
 * process startup.
 */
function _addCaCert(certPath) {
  try {
    const cert = readFileSync(certPath, 'utf-8');

    // Append to the default CA list rather than replacing it.
    const defaultCAs = tls.rootCertificates;
    const combined = [...defaultCAs, cert];

    tls.createSecureContext = ((original) => {
      return function (options = {}) {
        if (!options.ca) {
          options = { ...options, ca: combined };
        }
        return original(options);
      };
    })(tls.createSecureContext);

    console.log(`[aifs] Proxy detected — added CA certificate from ${certPath}`);
  } catch (err) {
    console.warn(`[aifs] Failed to load CA certificate from ${certPath}: ${err.message}`);
  }
}
