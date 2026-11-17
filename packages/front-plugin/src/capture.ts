import type { CaptureAnswer, CaptureCreate, CaptureMessage, JsonValue } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

/** Front conversation tag shape (matches `@frontapp/ui-bridge` `ApplicationTag`). */
export interface FrontTagSnapshot {
  id?: string;
  name: string;
}

/** Front custom field attribute shape (matches `@frontapp/ui-bridge` `ApplicationCustomAttribute`). */
export interface FrontCustomAttributeSnapshot {
  id: string;
  name: string;
  type: string;
  value: string | number | boolean | Date;
}

/** Front message content shape (matches `@frontapp/ui-bridge` `ApplicationMessageContent`). */
export interface FrontContentSnapshot {
  body: string;
  type: "html" | "text";
}

/** Front message snapshot (matches `@frontapp/ui-bridge` `ApplicationMessage`). */
export interface FrontMessageSnapshot {
  id: string;
  subject?: string;
  date: Date | string | number;
  status: "inbound" | "outbound" | string;
  content?: FrontContentSnapshot;
  from?: {
    handle?: string;
    name?: string;
  };
}

/** Front internal comment snapshot (matches `@frontapp/ui-bridge` `ApplicationComment`). */
export interface FrontCommentSnapshot {
  id: string;
  author?: {
    name?: string;
    email?: string;
    username?: string;
  };
  content: {
    body: string;
  };
  createdAt: Date | string | number;
}

/** What the plugin knows about the Front conversation and its loaded thread. */
export interface ConversationSnapshot {
  id: string;
  subject?: string;
  recipient?: {
    handle?: string;
    name?: string;
  };
  tags?: ReadonlyArray<FrontTagSnapshot>;
  customFieldAttributes?: ReadonlyArray<FrontCustomAttributeSnapshot>;
  messages: ReadonlyArray<FrontMessageSnapshot>;
  comments?: ReadonlyArray<FrontCommentSnapshot>;
  url?: string | null;
}

export interface AppSettings {
  baseUrl: string;
  agent: string;
  /** Require a picked reason code when the teammate changed the draft (default: true). */
  requireReason: boolean;
  /** Also include internal Front team comments in `context` as `note` entries. */
  captureInternalNotes: boolean;
  /** `cf_123:coverage, reserve:reserve` -> decision fields tracked by label. */
  decisionFields: Array<{ id: string; label: string }>;
  /** Replies shorter than this never count as an auto-detected draft. */
  minDraftChars: number;
  /** When set, only conversations carrying this tag are watched; all others are never read. */
  scopeTag: string | null;
  /** Which quick-pick reasons the reviewer sees: support (default) or claims. */
  reasonPack: ReasonPack;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  requireReason: true,
  captureInternalNotes: false,
  decisionFields: [],
  minDraftChars: 80,
  scopeTag: null,
  reasonPack: "support",
};

/** Parses plugin settings from URL query parameters, Front preferences, or stored config. */
export function settingsFrom(raw: Record<string, unknown>): AppSettings {
  const str = (k: string): string | null => {
    const v = raw[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const bool = (k: string, d: boolean): boolean => {
    const v = raw[k];
    if (typeof v === "boolean") return v;
    if (typeof v === "string") {
      const norm = v.trim().toLowerCase();
      if (norm === "true" || norm === "1") return true;
      if (norm === "false" || norm === "0") return false;
    }
    return d;
  };
  const fields = (str("decision_fields") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [rawId = "", rawLabel = ""] = s.split(":").map((x) => x.trim());
      return { id: rawId, label: rawLabel || rawId };
    })
    .filter((f) => f.id.length > 0);
  const minRaw = str("min_draft_chars");
  const min = minRaw === null ? Number.NaN : Number(minRaw);
  return {
    baseUrl: (str("overturn_base_url") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", DEFAULT_SETTINGS.requireReason),
    captureInternalNotes: bool("capture_internal_notes", DEFAULT_SETTINGS.captureInternalNotes),
    decisionFields: fields,
    minDraftChars: Number.isFinite(min) && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
    scopeTag: str("scope_tag"),
    reasonPack: reasonPackFrom(str("reason_pack")),
  };
}

/** Extracts tag names from Front conversation tags. */
export function tagNamesFrom(tags: ReadonlyArray<FrontTagSnapshot> | undefined): string[] {
  return (tags ?? []).map((t) => t.name).filter((n) => n.trim().length > 0);
}

/**
 * Whether the plugin should watch this conversation at all. With no scope tag every conversation
 * is eligible, though nothing beyond `draftId` is read until a draft appears. With a scope tag,
 * conversations missing it are never read at all.
 */
export function inScope(tags: readonly string[], settings: AppSettings): boolean {
  if (!settings.scopeTag) return true;
  return tags.includes(settings.scopeTag);
}

/** Converts Front's customFieldAttributes into a JSON-safe decision-fields record by label. */
export function customFieldsFrom(
  attributes: ReadonlyArray<FrontCustomAttributeSnapshot> | undefined,
  decisionFields: readonly { id: string; label: string }[],
): Record<string, JsonValue> {
  if (decisionFields.length === 0) return {};
  const list = attributes ?? [];
  const out: Record<string, JsonValue> = {};
  for (const field of decisionFields) {
    const hit = list.find(
      (a) => a.id === field.id || a.name === field.id || a.name.toLowerCase() === field.id.toLowerCase(),
    );
    if (!hit) {
      out[field.label] = null;
    } else if (hit.value instanceof Date) {
      out[field.label] = hit.value.toISOString();
    } else {
      out[field.label] = hit.value;
    }
  }
  return out;
}

/**
 * Where the draft came from. Watching the composer draft: the first time it jumps to
 * reply-sized text in one change (or opens pre-filled), that text is the draft.
 * The teammate can also mark the current draft manually, or a drafting agent can record
 * its run with the SDK (`externalId: "fr:<conversation id>"`).
 */
export type DraftOrigin = "inserted" | "manual" | "recorded" | "preloaded";

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  runId?: string;
  model?: string | null;
  at: number;
}

export interface DraftDetector {
  /** Feed every observed draft text; returns the draft the first time one appears. */
  onComposer(text: string, now?: number): DraftState | null;
  current(): DraftState | null;
  set(d: DraftState | null): void;
}

export function createDraftDetector(opts: { minDraftChars: number; typingWindowMs?: number }): DraftDetector {
  const window = opts.typingWindowMs ?? 1500;
  let draft: DraftState | null = null;
  let last = { text: "", at: 0 };
  let seen = false;
  return {
    onComposer(text, now = Date.now()) {
      const prev = last;
      const firstSight = !seen;
      seen = true;
      last = { text, at: now };
      if (draft) return null;
      const grew = text.length - prev.text.length;
      // A jump of reply size in one change (or a reply-sized draft on first sight).
      const jump =
        grew >= opts.minDraftChars && (prev.text.length < opts.minDraftChars / 2 || now - prev.at > window);
      const first = firstSight && text.length >= opts.minDraftChars;
      if (jump || first) {
        draft = { text, origin: first ? "preloaded" : "inserted", at: now };
        return draft;
      }
      return null;
    },
    current: () => draft,
    set: (d) => {
      draft = d;
    },
  };
}

/** Strips HTML from Front message/draft bodies into clean human-readable text. */
export function stripHtml(html: string): string {
  return normalizeCaptureText(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'"),
  );
}

/** Extracts plain text from Front message or draft content. */
export function extractBodyText(content: FrontContentSnapshot | undefined): string {
  if (!content?.body) return "";
  return content.type === "html" ? stripHtml(content.body) : normalizeCaptureText(content.body);
}

function toTimestampMs(value: Date | string | number | undefined | null): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toIsoOrNull(value: Date | string | number | undefined | null): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === "number") return Number.isFinite(value) ? new Date(value).toISOString() : null;
  if (typeof value === "string" && value.trim()) return value;
  return null;
}

/**
 * The conversation thread the expert saw when answering, oldest first.
 * Excludes the newly sent outbound message (`excludeMessageId`) when provided.
 */
export function contextFrom(
  conversation: ConversationSnapshot,
  opts: { excludeMessageId?: string; captureInternalNotes?: boolean } = {},
): CaptureMessage[] {
  const entries: Array<{ atMs: number; index: number; msg: CaptureMessage }> = [];
  let index = 0;

  for (const m of conversation.messages) {
    if (opts.excludeMessageId && m.id === opts.excludeMessageId) continue;
    const text = extractBodyText(m.content);
    if (!text) continue;
    entries.push({
      atMs: toTimestampMs(m.date),
      index: index++,
      msg: {
        role: m.status === "outbound" ? "agent" : "customer",
        author: m.from?.handle || m.from?.name || null,
        content: text,
        at: toIsoOrNull(m.date),
      },
    });
  }

  if (opts.captureInternalNotes && conversation.comments) {
    for (const c of conversation.comments) {
      const text = normalizeCaptureText(c.content?.body ?? "");
      if (!text) continue;
      entries.push({
        atMs: toTimestampMs(c.createdAt),
        index: index++,
        msg: {
          role: "note",
          author: c.author?.email || c.author?.name || c.author?.username || null,
          content: text,
          at: toIsoOrNull(c.createdAt),
        },
      });
    }
  }

  entries.sort((a, b) => a.atMs - b.atMs || a.index - b.index);
  return entries.map((e) => e.msg);
}

/**
 * Identifies the newly sent outbound message after a draft disappears from the conversation.
 * Returns `null` when the draft was discarded without sending.
 */
export function findSentMessage(
  messages: ReadonlyArray<FrontMessageSnapshot>,
  opts: { knownMessageIds?: ReadonlySet<string> | null; draftAt: number; skewMs?: number },
): FrontMessageSnapshot | null {
  const skewMs = opts.skewMs ?? 5_000;
  const outbound = messages.filter((m) => m.status === "outbound" && extractBodyText(m.content).length > 0);
  if (outbound.length === 0) return null;

  const candidates = opts.knownMessageIds
    ? outbound.filter((m) => !opts.knownMessageIds?.has(m.id))
    : outbound.filter((m) => toTimestampMs(m.date) >= opts.draftAt - skewMs);

  if (candidates.length === 0) return null;
  return candidates.reduce((latest, cur) =>
    toTimestampMs(cur.date) >= toTimestampMs(latest.date) ? cur : latest,
  );
}

export interface PendingSend {
  messageId?: string;
  text: string;
  fields: Record<string, JsonValue>;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

/** Builds Front's canonical conversation permalink. */
export function frontConversationUrl(conversationId: string): string {
  return `https://app.frontapp.com/open/${encodeURIComponent(conversationId)}`;
}

/** Pure decision logic on send: diffs draft vs sent and enforces `requireReason`. */
export function decideOnSend(input: {
  conversation: ConversationSnapshot;
  draft: DraftState | null;
  draftFields: Record<string, JsonValue>;
  send: PendingSend;
  reasonCode: string | null;
  reason: string;
  actor: string | null;
  settings: AppSettings;
  now?: number;
}): SendDecision {
  const { conversation, draft, send, settings } = input;
  const sentText = normalizeCaptureText(send.text);
  if (!sentText) return { action: "skip", why: "empty" };
  if (!draft) return { action: "skip", why: "no-draft" };

  const hasFields = settings.decisionFields.length > 0;
  const draftAnswer: CaptureAnswer = {
    text: stripHtml(draft.text),
    ...(hasFields ? { fields: input.draftFields } : {}),
  };
  const sentAnswer: CaptureAnswer = {
    text: sentText,
    ...(hasFields ? { fields: send.fields } : {}),
  };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = input.reason.trim();
  const reasonCode = input.reasonCode?.trim() || null;
  if (diff.changed && settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }

  const body: CaptureCreate = {
    source: "front",
    externalId: `fr:${conversation.id}`,
    agent: settings.agent,
    actor: input.actor,
    subject: conversation.subject ?? null,
    context: contextFrom(conversation, {
      excludeMessageId: send.messageId,
      captureInternalNotes: settings.captureInternalNotes,
    }),
    draft: draftAnswer,
    sent: sentAnswer,
    reason: reason || null,
    reasonCode: diff.changed ? reasonCode : null,
    secondsToSend: Math.min(
      86_400 * 30,
      Math.max(0, Math.round(((input.now ?? Date.now()) - draft.at) / 100) / 10),
    ),
    draftRunId: draft.runId ?? null,
    draftModel: draft.model ?? null,
    url: conversation.url ?? frontConversationUrl(conversation.id),
    tags: [`draft:${draft.origin}`, "public-reply"],
    metadata: { requester: conversation.recipient?.handle ?? conversation.recipient?.name ?? null },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/** Short status line for the Front sidebar panel. */
export function statusLine(
  d: DraftState | null,
  lastResult: { kind: string; changed: boolean; dedup: boolean } | null,
): string {
  if (lastResult) {
    if (!lastResult.changed) return "Sent as drafted · approved";
    return lastResult.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
  }
  if (!d) return "Waiting for a draft";
  const words = d.text.trim().split(/\s+/).filter(Boolean).length;
  const from = {
    inserted: "inserted",
    manual: "marked by you",
    recorded: "recorded by your agent",
    preloaded: "found in the composer",
  }[d.origin];
  return `Draft ${from} · ${words} words`;
}

/** Quick-pick reason options for the configured pack. */
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}
