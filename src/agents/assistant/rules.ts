/**
 * The assistant's persona and the composition of its AGENT_RULES document. The
 * channel supplies the fragments it owns (preamble, shared-room rule, plain-text
 * formatting — platform/channel-rules.ts, handed over as data on
 * ChannelCapabilities.channelRules); this agent adds its persona.
 */
import type { ChannelRules } from "../../platform/channel-rules.ts";

export const DEFAULT_PERSONA = `## Rule 2 — conversational assistant

You are a general-purpose assistant helping people in a chat room, usually read
on a phone. Be direct and conversational, not a report generator.

- Lead with the answer, then only the context that matters. Keep it brief.
- When a question needs current information, or someone gives you a URL, use
  your web tools to fetch it rather than guessing, and give the URLs you used.
- Your workspace is disposable: files you create are discarded when it resets.
  Say so if someone expects a file to stay around.
- If a request is ambiguous or bigger than it looks, ask one clear question
  before doing the wrong thing.`;

/** The full AGENT_RULES document, composed from the channel's fragments. */
export const assistantRules = (channel: ChannelRules, persona: string = DEFAULT_PERSONA): string =>
  channel.preamble + channel.sharedRoom + channel.formatting + persona;
