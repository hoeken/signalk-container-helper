// Normalising an operator-typed service URL.
//
// The "self-hosted" half of the managed/self-hosted switch: the operator types
// an address into a plugin's config form and every consumer then appends its
// own absolute API path to it. Left raw, three ordinary inputs break that:
// a bare `192.168.1.50:3010` has no scheme for `fetch`, a trailing slash turns
// `${base}/api/health` into `//api/health` (which many routers 404), and a
// pasted browser URL carries a path nobody wants.
//
// Uses the `URL` global, NOT `node:url` — this module is imported by both the
// Node entry and the browser (`/ui`) entry, and the main entry's "imports no
// Node builtins" property is load-bearing (see AGENTS.md).

export interface NormalizeUrlOptions {
  /** Scheme applied to a bare host/IP. Default "http". */
  defaultScheme?: "http" | "https";
  /**
   * Port appended when the input carries none. Omit to leave a
   * scheme-default-port URL alone — correct for a reverse-proxied
   * `https://backup.example.com`.
   */
  defaultPort?: number;
}

export interface NormalizedUrl {
  /** Scheme-ful, no trailing slash, no path/query/hash. */
  baseUrl: string;
  /** `host:port`, or bare `host` when no explicit port survived. */
  address: string;
  scheme: "http" | "https";
  /** Hostname without brackets; an IPv6 literal is bare here. */
  host: string;
  /** null when the URL relies on the scheme's default port. */
  port: number | null;
}

// A scheme is `://`, not merely a colon: `192.168.1.50:3010` and a bare IPv6
// literal both contain colons but neither has a scheme.
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

// True when the authority the operator typed carries its own `:port`. Works on
// the pre-parse string because `URL` has already discarded a scheme-default
// port by the time it can be inspected. The host may be a bracketed IPv6
// literal, whose internal colons must not count.
function hasExplicitPort(candidate: string): boolean {
  const afterScheme = candidate.slice(candidate.indexOf("://") + 3);
  // The authority ends at the first `/`, `?` or `#`.
  const authority = afterScheme.split(/[/?#]/)[0] ?? "";
  const lastColon = authority.lastIndexOf(":");
  if (lastColon === -1) return false;
  const closingBracket = authority.lastIndexOf("]");
  // A colon inside (or before) the bracket belongs to the IPv6 literal.
  if (closingBracket !== -1 && lastColon < closingBracket) return false;
  return /^\d+$/.test(authority.slice(lastColon + 1));
}

function schemeDefaultPort(protocol: string): number {
  return protocol === "https:" ? 443 : 80;
}

/**
 * Normalise operator input into a base URL consumers can append paths to.
 *
 * Returns null for anything unusable rather than throwing: the caller decides
 * whether an empty field is "not configured yet" (a status message) or a hard
 * error, and those two want different copy.
 *
 * Deliberately NOT checked here: reachability, DNS, or whether the host looks
 * like a LAN address. This is pure and synchronous; reachability is
 * `waitForEndpointReady`'s job and its failure message is far better than
 * anything a syntactic guess could produce.
 */
export function normalizeExternalUrl(
  raw: string | undefined | null,
  options: NormalizeUrlOptions = {},
): NormalizedUrl | null {
  if (typeof raw !== "string") return null;

  // Strip wrapping quotes as well as whitespace: copying a value out of a
  // YAML/JSON snippet brings them along, and `"http://x"` is otherwise a
  // baffling parse failure.
  let text = raw.trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      text = text.slice(1, -1).trim();
    }
  }
  if (!text) return null;

  const scheme = options.defaultScheme ?? "http";
  const candidate = HAS_SCHEME.test(text) ? text : `${scheme}://${text}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  // Only http(s): `ftp://`, `file://` and the classic `htp://` typo are all
  // wrong in a way the operator wants told, not silently coerced.
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;

  // `new URL("http://x:0")` parses, and port 0 is not a service address.
  let port: number | null = url.port === "" ? null : Number(url.port);
  if (port !== null && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
    return null;
  }
  // `URL` drops a port that matches the scheme default, so `url.port` is ""
  // for BOTH "http://x" and "http://x:80". Applying defaultPort on that alone
  // would silently move an operator who deliberately typed :80 onto some
  // other port. Ask the authority the operator actually wrote instead.
  if (port === null && options.defaultPort !== undefined) {
    port = hasExplicitPort(candidate)
      ? schemeDefaultPort(url.protocol)
      : options.defaultPort;
  }

  // url.hostname brackets an IPv6 literal; keep the bare form in `host` and
  // re-bracket only where the colon would otherwise be ambiguous.
  const bareHost = url.hostname.startsWith("[")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const hostForUrl = bareHost.includes(":") ? `[${bareHost}]` : bareHost;

  const protocol = url.protocol === "https:" ? "https" : "http";
  const address = port === null ? hostForUrl : `${hostForUrl}:${port}`;

  // Path, query and fragment are DISCARDED, not rejected: a pasted browser URL
  // should work, and every consumer appends its own absolute API path.
  return {
    baseUrl: `${protocol}://${address}`,
    address,
    scheme: protocol,
    host: bareHost,
    port,
  };
}
