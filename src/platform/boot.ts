/**
 * Platform boot helpers — Matrix credential resolution and the E2EE crypto
 * store location. Composition roots (broker.ts) use these before building any
 * agent's layers; nothing here knows about an agent.
 */
import { readFile } from "node:fs/promises";
import { resolveCryptoStorePath } from "./util.ts";

export type MatrixCredentials = { readonly homeserver: string; readonly token: string };

const DEFAULT_ACCOUNT_FILE = "/data/bot-account.json";
const COMPOSE_WAIT_MS = 120_000;
const RETRY_MS = 2000;

/**
 * Resolves the bot's homeserver + access token. External-Matrix deployments
 * provide MATRIX_HOMESERVER/MATRIX_TOKEN directly. In compose mode the bundled
 * homeserver's bootstrap (deploy/bootstrap) creates the bot account instead and
 * writes its credentials to /data/bot-account.json — we pick them up here,
 * waiting up to 120s (2s retries) since the broker deliberately has no
 * depends_on on the bootstrap (see deploy/docker-compose.yml).
 */
export async function resolveMatrixCredentials(
  opts: {
    readonly homeserver?: string;
    readonly token?: string;
    readonly accountFile?: string;
    readonly compose?: boolean;
    readonly waitMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<MatrixCredentials> {
  const accountFile = opts.accountFile ?? DEFAULT_ACCOUNT_FILE;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let homeserver = opts.homeserver ?? process.env.MATRIX_HOMESERVER ?? "";
  let token = opts.token ?? process.env.MATRIX_TOKEN ?? "";
  if (homeserver && token) return { homeserver, token };

  const compose = opts.compose ?? process.env.WORKSPACE_BACKEND === "compose";
  const waitMs = opts.waitMs ?? (compose ? COMPOSE_WAIT_MS : 0);
  const deadline = Date.now() + waitMs;
  console.log(`[alveole] MATRIX_TOKEN absent — waiting for ${accountFile} (bundled bootstrap)…`);
  do {
    try {
      const acct = JSON.parse(await readFile(accountFile, "utf8")) as {
        homeserverUrl?: string;
        botAccessToken?: string;
      };
      // The bootstrap writes a coherent pair — take both or neither. Mixing a
      // half-set env var with the file sends the local bot's token to a
      // foreign homeserver (M_MISSING_TOKEN at startup).
      if (acct.homeserverUrl && acct.botAccessToken) {
        homeserver = acct.homeserverUrl;
        token = acct.botAccessToken;
        break;
      }
      homeserver = homeserver || acct.homeserverUrl || "";
      token = token || acct.botAccessToken || "";
      if (homeserver && token) break;
    } catch {
      // not written yet (bootstrap still running) or a partial write
    }
    if (Date.now() >= deadline) break;
    await sleep(RETRY_MS);
  } while (true);

  if (!homeserver || !token) {
    if (compose) {
      throw new Error(
        "no usable /data/bot-account.json within 120s — the bootstrap didn't produce the bot's credentials; check `docker compose -f deploy/docker-compose.yml --env-file .env logs bootstrap` and the homeserver container's logs",
      );
    }
    throw new Error(
      "MATRIX_HOMESERVER and MATRIX_TOKEN required (compose mode reads them from /data/bot-account.json, written by deploy/bootstrap)",
    );
  }
  return { homeserver, token };
}

/**
 * E2EE is on by default. The crypto store persists the bot's device identity
 * and room keys; keep it on the same durable volume as the registry (compose:
 * /data, k8s: the registry PVC) or the bot gets a new device on every restart
 * and can't decrypt history. MATRIX_E2EE=false opts out (unencrypted rooms
 * only); MATRIX_CRYPTO_STORE overrides the directory.
 */
export function cryptoStorePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return resolveCryptoStorePath({
    registryDbPath: env.REGISTRY_DB_PATH ?? "registry.db",
    e2eeEnv: env.MATRIX_E2EE,
    cryptoStoreEnv: env.MATRIX_CRYPTO_STORE,
  });
}
