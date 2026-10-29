// What server and web exchange about the sign-in through an auth proxy (AD-049). One definition for both sides
// (code-006): a change on one side that the other does not follow fails to compile. Types and constants only.

// Pangolin was one too until AD-058: it has no sign-out address, so „Abmelden“ could never end its sign-in.
export const PROXY_PROVIDERS = ['authentik'] as const;
export type ProxyProvider = (typeof PROXY_PROVIDERS)[number];

/** Product names as shown in the interface and the protocol. */
export const PROXY_LABEL: Record<ProxyProvider, string> = { authentik: 'Authentik' };

/** What the admin sets per provider. The server also keeps the hash of the shared secret – that never leaves it. */
export interface ProxyAuthSettings {
  enabled: boolean;
  /** Single addresses (no ranges, owner 2026-10-15) the proxy connects from, as Kaveyl Wiki sees them on the socket. */
  proxies: string[];
  /** Header with the fixed id of the person at the provider (connect + sign-in). Lower case. */
  idHeader: string;
  /** Header with the e-mail address (only for "connect by e-mail"). Lower case. */
  emailHeader: string;
  /** Where "Abmelden" sends the browser after Kaveyl Wiki's own session ended – required while switched on (AD-058). */
  logoutUrl: string;
  /** Normal users (never admins) whose e-mail matches are connected on their first visit through the proxy. */
  autoLinkByEmail: boolean;
}

/** Fields of the settings form a refusal can point at: the form shows the message there (design-006). */
export const PROXY_FIELDS = ['proxies', 'idHeader', 'emailHeader', 'logoutUrl'] as const;
export type ProxyField = (typeof PROXY_FIELDS)[number];

/** What this very request looked like – the setup help of the tab. Header values only from a trusted address. */
export interface ProxyRequestInfo {
  socket: string;
  trusted: boolean;
  idHeaderSeen: boolean;
  emailHeaderSeen: boolean;
  subject: string | null;
  email: string | null;
  gateway: string | null;
  socketIsGateway: boolean;
  /** A shared secret came with the request (never its value). */
  secretSeen: boolean;
  /** … and it matches the stored one. */
  secretOk: boolean;
}

/** The provider's tab: settings plus what this request looked like. */
export interface ProxyAuthState {
  /** The stored values as far as readable – also when they fail the check (then `problem` says why). */
  config: ProxyAuthSettings;
  /** Why the stored setting fails the check – the sign-in through this provider is off until it is corrected. */
  problem: string | null;
  /** A shared secret is set (sec-003): the proxy must send it in X-Kaveyl-Wiki-Proxy-Secret. The value is shown only once. */
  secretSet: boolean;
  /** Loopback addresses (127.x / ::1) among the proxy addresses – allowed (proxy on the same machine), but every program there counts. */
  loopback: string[];
  request: ProxyRequestInfo;
  /** Accounts connected to this provider. */
  linked: number;
}

/** A provider in the own account's tab: switched on, or still connected. */
export interface AccountProxy {
  provider: ProxyProvider;
  label: string;
  enabled: boolean;
  linkedAt: string | null;
  /** This request came through the provider with an identity – connecting is possible now. */
  available: boolean;
}
