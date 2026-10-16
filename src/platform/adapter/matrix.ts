/**
 * Matrix chat adapter — transport #1.
 *
 * The ONLY module that knows about Matrix: sync redelivery dedup, message
 * filters (own messages, non-text, pre-start events), event rendering with
 * the current emoji formatting, redaction (needs moderator power level), room
 * labels, E2EE (optional Rust crypto store — decrypts inbound, encrypts
 * outbound), and the approval-answer vocabulary. Swap this file for another
 * platform without touching any agent (agents/*).
 *
 * Rendering notes: events carry semantics, not presentation — the emoji
 * prefixes below are this channel's rendering choices, and `result` output is
 * chunked to Matrix's event size limit (see capabilities.maxMessageChars).
 */
import { AutojoinRoomsMixin, MatrixClient, RustSdkCryptoStorageProvider, SimpleFsStorageProvider } from "matrix-bot-sdk";
import { StoreType as RustSdkCryptoStoreType } from "@matrix-org/matrix-sdk-crypto-nodejs";
import { Effect, Layer } from "effect";
import { ChatAdapter, type ChannelCapabilities, type ChatAdapterService, type InboundMessage, type OutboundEvent } from "./types.ts";
import { channelRulesFor } from "../channel-rules.ts";
import { describeError } from "../util.ts";

export type MatrixAdapterConfig = {
  readonly homeserver: string;
  readonly token: string;
  /** Where the sync token/filter state persists (usually on the /data volume). */
  readonly storagePath: string;
  /**
   * Directory for the E2EE crypto store (device keys + megolm sessions).
   * Undefined disables E2EE — the bot then works in unencrypted rooms only.
   * Must survive restarts, or the bot loses its device identity and can no
   * longer decrypt events it previously could (see src/broker.ts).
   */
  readonly cryptoStoragePath?: string;
};

/**
 * Matrix events have a hard size limit (~64KB server-side); long agent replies
 * (full file listings, long summaries) can exceed it, and one oversized
 * sendText would lose the whole turn output. Split on line boundaries into
 * chunks that are individually safe to send, in order.
 */
export function splitForMatrix(text: string, chunkSize = 3000): string[] {
  if (text.length <= chunkSize) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > chunkSize) {
    let cut = rest.lastIndexOf("\n", chunkSize);
    if (cut < chunkSize / 2) cut = chunkSize; // no good line boundary — hard-split
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, ""); // drop the newline(s) we split on
  }
  if (rest) chunks.push(rest);
  return chunks;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a Matrix event explicitly addresses the bot. Two signals:
 * - modern clients set `m.mentions.user_ids` (MSC3952) — authoritative; an
 *   `@room` mention sets `room: true` with no user id and must NOT trigger;
 * - as a fallback for clients that don't emit m.mentions, an explicit
 *   `@localpart` (e.g. `@coding-agent`) or `@mxid` in the body.
 * The bare display name is deliberately NOT matched — that would let an
 * unrelated mention of the bot's name fire it, the exact accident this gate
 * exists to prevent.
 */
export function isBotMentioned(me: string, content: any): boolean {
  if (isBotMentionedViaMentions(me, content)) return true;
  const body = typeof content?.body === "string" ? content.body : "";
  const localpart = me.split(":")[0]; // Matrix localpart includes the leading "@"
  return new RegExp(`${escapeRegExp(localpart)}(?![\\w-])`).test(body);
}

/** The authoritative signal alone: `m.mentions.user_ids` (MSC3952) names the
 * bot explicitly. Distinct from `isBotMentioned` because callers may need to
 * know the mention was client-confirmed rather than inferred from the body. */
export function isBotMentionedViaMentions(me: string, content: any): boolean {
  const mentions = content?.["m.mentions"];
  return Array.isArray(mentions?.user_ids) && mentions.user_ids.includes(me);
}

/**
 * Removes a leading mention token from a message so anchored parsers (slash
 * commands, onboarding input, yes/no approval answers) still see
 * the actual payload — while the raw text keeps the mention for the agent.
 * Element puts the mention first and, when it emits `m.mentions`, renders the
 * bot's display name in the body; older clients leave the literal `@localpart`
 * or `@mxid`. Longest token first so an mxid isn't half-consumed by its
 * localpart prefix. Case-insensitive; only the START is touched.
 *
 * By default the token must end on a non-word boundary, so a *different*
 * handle that merely starts with ours (e.g. `@coding-agent-2`) is left alone.
 * Some clients glue the mention pill straight onto the payload with no
 * separator (`@coding-agentyes`), which that guard would refuse to strip; when
 * the adapter has already confirmed the bot was mentioned (an authoritative
 * `m.mentions.user_ids` hit) pass `authoritative` to drop the boundary and
 * recover the answer.
 */
export function stripMention(
  body: string,
  tokens: Array<string | undefined>,
  opts: { readonly authoritative?: boolean } = {},
): string {
  const alts = tokens
    .filter((t): t is string => !!t && t.length > 0)
    .map((t) => escapeRegExp(t.replace(/^@/, "")))
    .sort((a, b) => b.length - a.length);
  if (!alts.length) return body.trim();
  // `@?` so an Element-style display-name mention ("@Coding Agent …" or
  // "Coding Agent: …") is covered alongside the literal "@localpart".
  const boundary = opts.authoritative ? "" : "(?![\\w-])";
  const re = new RegExp(`^\\s*@?(?:${alts.join("|")})${boundary}\\s*[:,\\-–—]?\\s*`, "i");
  return body.replace(re, "").trim();
}

/** Renders one base outbound event to this channel's text. Exported so the
 * wire format is unit-testable without a live Matrix client. */
export function renderOutbound(event: OutboundEvent): string {
  switch (event.type) {
    case "status":
    case "info":
    case "usage":
    case "result":
      return event.text;
    case "error":
      return `⚠️ ${event.text}`;
  }
}

// Approval vocabulary: "y", "yes", "ok", "go"…
// allow; anything else (that isn't a command — the core checks those first)
// denies. A future adapter with approval buttons ignores this entirely.
const APPROVAL_ANSWER_RE = /^(y|yes|ok|okay|approve|approved|go|sure|👍|✅)\b/i;

// Matrix sync can redeliver events across reconnects; without dedup a single
// redelivered "run this task" gets answered twice. Capped so it can't grow
// without bound; clearing at the cap is fine — duplicates only matter within
// seconds of each other, and even the smallest cap far exceeds that.
const SEEN_EVENT_IDS_CAP = 2000;

const makeMatrixAdapter = (config: MatrixAdapterConfig): Effect.Effect<ChatAdapterService, "chat-start-failed"> =>
  Effect.gen(function* () {
    // Constructor is sync and can only fail on bad arguments — still classified
    // so nothing below this line can throw.
    const client = yield* Effect.try({
      try: () => {
        // A RustSdkCryptoStorageProvider is the only crypto store matrix-bot-sdk
        // supports; its presence is what enables E2EE. With it, the SDK
        // decrypts inbound m.room.encrypted events (and re-emits them through
        // the room.message/room.event handlers below) and transparently
        // encrypts outbound sends in encrypted rooms. Unencrypted rooms are
        // unaffected either way.
        const cryptoStore = config.cryptoStoragePath
          ? new RustSdkCryptoStorageProvider(config.cryptoStoragePath, RustSdkCryptoStoreType.Sqlite)
          : undefined;
        return new MatrixClient(
          config.homeserver,
          config.token,
          new SimpleFsStorageProvider(config.storagePath),
          cryptoStore,
        );
      },
      catch: (cause) => {
        console.error(`[matrix] chat-start-failed: cannot construct client — ${describeError(cause)}`);
        return "chat-start-failed" as const;
      },
    });
    AutojoinRoomsMixin.setupOnClient(client); // join when invited — this channel's membership policy
    const me = yield* Effect.tryPromise({
      try: () => client.getUserId(),
      catch: (cause) => {
        console.error(`[matrix] chat-start-failed: getUserId failed — ${describeError(cause)}`);
        return "chat-start-failed" as const;
      },
    });
    const startedAt = Date.now();
    console.log(`[alveole] matrix adapter up as ${me} on ${config.homeserver}`);
    console.log(
      config.cryptoStoragePath
        ? `[alveole] matrix E2EE enabled — crypto store at ${config.cryptoStoragePath}`
        : `[alveole] matrix E2EE disabled — unencrypted rooms only (set MATRIX_E2EE=true to enable)`,
    );

    const seenEventIds = new Set<string>();

    const botMention = me.split(":")[0]; // e.g. "@coding-agent"
    const capabilities: ChannelCapabilities = {
      markdown: false,
      maxMessageChars: 3000,
      canRedact: true,
      selfMention: botMention,
      channelRules: channelRulesFor(botMention),
    };

    const send = (conversationId: string, event: OutboundEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        const text = renderOutbound(event);
        console.log(`[${conversationId}] → ${event.type}`);
        for (const part of splitForMatrix(text, capabilities.maxMessageChars)) {
          yield* Effect.tryPromise(() => client.sendText(conversationId, part));
        }
      }).pipe(
        // Never fail the core because chat delivery hiccuped.
        Effect.catchAll((err) =>
          Effect.sync(() => console.warn(`[${conversationId}] failed to send ${event.type}:`, describeError(err))),
        ),
      );

    const redact = (conversationId: string, messageId: string): Effect.Effect<boolean> =>
      Effect.tryPromise(() => client.redactEvent(conversationId, messageId, "token removed from history")).pipe(
        Effect.as(true),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            console.warn(`[${conversationId}] failed to redact token message:`, describeError(err));
            return false;
          }),
        ),
      );

    const label = (conversationId: string): Effect.Effect<string | undefined> =>
      Effect.tryPromise(() => client.getRoomStateEvent(conversationId, "m.room.name", "")).pipe(
        Effect.map((state) => state?.name as string | undefined),
        Effect.catchAll(() => Effect.succeed(undefined)),
      );

    // Sender display names for the ambient transcript, resolved once per user
    // and cached. A failed lookup returns the MXID but is not cached, so it
    // can succeed later — the transcript just falls back to the raw id in the
    // meantime, which is still intelligible.
    const senderNames = new Map<string, string>();
    const resolveSenderName = (roomId: string, userId: string): Promise<string> => {
      const cached = senderNames.get(userId);
      if (cached) return Promise.resolve(cached);
      return client
        .getRoomStateEvent(roomId, "m.room.member", userId)
        .then((member: any) => {
          const name =
            typeof member?.displayname === "string" && member.displayname ? member.displayname : userId;
          senderNames.set(userId, name);
          return name;
        })
        .catch(() => userId);
    };

    // The bot's own display name per room — needed to strip an Element-style
    // mention ("Coding Agent …") from the routed text. Resolved through the
    // same cache, so a failure degrades to the MXID (still covered by the
    // localpart token).
    const botNameByRoom = new Map<string, string>();
    const resolveBotName = (roomId: string): Promise<string> => {
      const cached = botNameByRoom.get(roomId);
      if (cached) return Promise.resolve(cached);
      return resolveSenderName(roomId, me).then((name) => {
        botNameByRoom.set(roomId, name);
        return name;
      });
    };

    const start = (
      onInbound: (msg: InboundMessage) => void,
      onAbandoned: (conversationId: string) => void,
      onJoined: (conversationId: string) => void,
    ): Effect.Effect<void, "chat-start-failed"> =>
      Effect.gen(function* () {
        // The bot's own join: AutojoinRoomsMixin accepts invites, and the SDK
        // emits room.join once for a room it wasn't already in when start()
        // ran (lastJoinedRoomIds dedups restarts). Greet it right away so
        // onboarding begins without waiting for the user's first message.
        client.on("room.join", (roomId: string) => {
          onJoined(roomId);
        });
        client.on("room.message", (roomId: string, event: any) => {
          if (event.sender === me) return;
          if (!event.content || event.content.msgtype !== "m.text") return;
          if ((event.origin_server_ts ?? 0) < startedAt) return;
          const eventId: string | undefined = event.event_id;
          if (eventId) {
            if (seenEventIds.has(eventId)) return;
            seenEventIds.add(eventId);
            if (seenEventIds.size > SEEN_EVENT_IDS_CAP) seenEventIds.clear();
          }
          const mentioned = isBotMentioned(me, event.content);
          // An `m.mentions.user_ids` hit is authoritative: the client is
          // telling us exactly who was mentioned, so the leading pill can be
          // stripped even if it's glued to the payload (see stripMention).
          const viaMentions = isBotMentionedViaMentions(me, event.content);
          const raw = (event.content.body ?? "").trim();
          // Resolve names before handing the message to the core: ambient lines
          // are attributed to their author, and an addressed message needs its
          // mention stripped for command/onboarding/gate parsing.
          void Promise.all([
            resolveSenderName(roomId, event.sender),
            mentioned ? resolveBotName(roomId) : Promise.resolve(undefined),
          ]).then(([senderName, botName]) => {
            onInbound({
              conversationId: roomId,
              messageId: eventId,
              senderId: event.sender,
              senderName,
              mentioned,
              text: raw,
              directive: mentioned
                ? stripMention(raw, [me.split(":")[0], me, botName], { authoritative: viaMentions })
                : undefined,
            });
          });
        });
        // E2EE-only: a message the bot can't decrypt (missing room key, e.g.
        // sent before the bot joined, or a device it hasn't seen). It never
        // reaches onInbound, so surface it in the logs instead of going silent.
        client.on("room.failed_decryption", (roomId: string, event: any, err: unknown) => {
          console.warn(`[${roomId}] failed to decrypt ${event?.event_id ?? "an event"}:`, describeError(err));
        });
        // room.leave only fires for the bot's own membership (matrix-bot-sdk quirk) — anyone
        // else leaving/getting banned only shows up on the generic room.event firehose, so
        // that's what we filter here to notice "was someone else's membership just revoked".
        client.on("room.event", (roomId: string, event: any) => {
          if (event.type !== "m.room.member" || event.state_key === me) return;
          if (event.content?.membership !== "leave" && event.content?.membership !== "ban") return;
          void client
            .getJoinedRoomMembers(roomId)
            .then((members: string[]) => {
              if (members.every((id) => id === me)) onAbandoned(roomId);
            })
            .catch((err) => console.warn(`[${roomId}] failed to check room membership:`, describeError(err)));
        });
        yield* Effect.tryPromise({
          try: () => client.start(),
          catch: (cause) => {
            console.error(`[matrix] chat-start-failed: sync loop failed to start — ${describeError(cause)}`);
            return "chat-start-failed" as const;
          },
        });
        // client.start() snapshots the joined rooms (so room.join won't fire
        // for them) — greet those too, otherwise a room the bot already sits
        // in (bundled mode's pre-created room, or an invite accepted while the
        // broker was down) never gets its onboarding prompt. The core no-ops
        // on conversations it already knows.
        const joined = yield* Effect.tryPromise(() => client.getJoinedRooms()).pipe(
          Effect.catchAll((err) => {
            console.warn("[matrix] failed to list joined rooms for greeting:", describeError(err));
            return Effect.succeed([] as string[]);
          }),
        );
        for (const roomId of joined) onJoined(roomId);
      });

    return {
      capabilities,
      send,
      redact,
      label,
      start,
      parseApprovalAnswer: (text: string) => APPROVAL_ANSWER_RE.test(text),
    } satisfies ChatAdapterService;
  });

export const MatrixAdapterLive = (config: MatrixAdapterConfig) => Layer.effect(ChatAdapter, makeMatrixAdapter(config));
