/**
 * Small pure helpers shared across the platform layer — kept dependency-free
 * so they can be unit-tested without touching Matrix, the k8s API, or a live
 * workspace. Agent-specific helpers live in agents/<name>/util.ts.
 */
import { dirname, join } from "node:path";

/**
 * Where the Matrix E2EE crypto store lives (device keys + megolm sessions).
 *
 * E2EE is on by default; `MATRIX_E2EE=false` turns it off (unencrypted rooms
 * only). The store must persist across restarts — losing it means a fresh
 * device identity and undecryptable old events — so by default it sits next to
 * the registry DB, on the same durable volume. `MATRIX_CRYPTO_STORE` overrides
 * the directory. Returns undefined when E2EE is disabled.
 */
export function resolveCryptoStorePath(opts: {
  readonly registryDbPath: string;
  readonly e2eeEnv?: string;
  readonly cryptoStoreEnv?: string;
}): string | undefined {
  const enabled = !["false", "0", "no", "off"].includes((opts.e2eeEnv ?? "true").trim().toLowerCase());
  if (!enabled) return undefined;
  if (opts.cryptoStoreEnv) return opts.cryptoStoreEnv;
  return join(dirname(opts.registryDbPath), "crypto-store");
}

// fetch() wraps the real undici error (e.g. UND_ERR_HEADERS_TIMEOUT, UND_ERR_CONNECT_TIMEOUT)
// in a generic `TypeError: fetch failed` with the actual cause on `.cause` — logging err.message
// alone just prints "fetch failed" with no way to tell a timeout from a connect error.
export function describeError(err: unknown): string {
  const e = err as { cause?: { code?: string; message?: string }; code?: string; message?: string };
  const code = e?.cause?.code ?? e?.code;
  const message = e?.cause?.message ?? e?.message ?? String(err);
  return code ? `${message} (code=${code})` : message;
}
