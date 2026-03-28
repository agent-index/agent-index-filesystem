import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

/**
 * Test whether a domain is reachable through the current network environment.
 *
 * In proxy environments (Cowork, sandboxed VMs), outbound HTTPS goes through
 * an HTTP proxy via CONNECT tunnel. If the proxy has an allowlist, blocked
 * domains return 403 with "blocked-by-allowlist". This function detects that
 * and returns a clear result.
 *
 * @param {string} domain - Domain to test (e.g., "www.googleapis.com")
 * @param {number} [timeoutMs=10000] - Timeout in milliseconds
 * @returns {Promise<{reachable: boolean, reason?: string}>}
 */
export async function testDomainReachability(domain, timeoutMs = 10000) {
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;

  if (httpsProxy) {
    // In a proxy environment — test via CONNECT tunnel.
    return _testViaProxy(domain, httpsProxy, timeoutMs);
  }

  // No proxy — test direct DNS + TCP connection.
  return _testDirect(domain, timeoutMs);
}

/**
 * Test multiple domains and return results for each.
 *
 * @param {string[]} domains - Array of domains to test
 * @param {number} [timeoutMs=10000] - Timeout per domain
 * @returns {Promise<{allReachable: boolean, results: Object<string, {reachable: boolean, reason?: string}>}>}
 */
export async function testAllDomains(domains, timeoutMs = 10000) {
  const results = {};
  const promises = domains.map(async (domain) => {
    results[domain] = await testDomainReachability(domain, timeoutMs);
  });
  await Promise.all(promises);

  const allReachable = Object.values(results).every((r) => r.reachable);
  return { allReachable, results };
}

/**
 * Test reachability through an HTTP proxy CONNECT tunnel.
 */
function _testViaProxy(domain, proxyUrl, timeoutMs) {
  return new Promise((resolve) => {
    const proxy = new URL(proxyUrl);

    const req = http.request({
      host: proxy.hostname,
      port: proxy.port || 3128,
      method: 'CONNECT',
      path: `${domain}:443`,
      timeout: timeoutMs,
    });

    req.on('connect', (res, _socket) => {
      // Clean up the socket immediately — we only care about the status.
      _socket.destroy();

      if (res.statusCode === 200) {
        resolve({ reachable: true });
      } else if (res.statusCode === 403) {
        const proxyError = res.headers['x-proxy-error'] || '';
        if (proxyError.includes('allowlist')) {
          resolve({
            reachable: false,
            reason: 'blocked-by-allowlist',
          });
        } else {
          resolve({
            reachable: false,
            reason: `proxy-rejected-${res.statusCode}`,
          });
        }
      } else {
        resolve({
          reachable: false,
          reason: `proxy-status-${res.statusCode}`,
        });
      }
    });

    req.on('error', (err) => {
      resolve({
        reachable: false,
        reason: `connection-error: ${err.message}`,
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        reachable: false,
        reason: 'timeout',
      });
    });

    req.end();
  });
}

/**
 * Test reachability via direct HTTPS connection (no proxy).
 */
function _testDirect(domain, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: domain,
        port: 443,
        method: 'HEAD',
        path: '/',
        timeout: timeoutMs,
      },
      (res) => {
        res.destroy();
        // Any HTTP response means the domain is reachable.
        resolve({ reachable: true });
      }
    );

    req.on('error', (err) => {
      if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
        resolve({ reachable: false, reason: 'dns-failed' });
      } else if (err.code === 'ECONNREFUSED') {
        resolve({ reachable: false, reason: 'connection-refused' });
      } else {
        resolve({ reachable: false, reason: `error: ${err.message}` });
      }
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ reachable: false, reason: 'timeout' });
    });

    req.end();
  });
}
