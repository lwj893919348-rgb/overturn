import type {
  ApplicationCommentId,
  ApplicationCustomAttribute,
  ApplicationDraft,
  ApplicationDraftId,
  ApplicationMessage,
  ApplicationMessageId,
  ApplicationPaginationToken,
  ApplicationTag,
  HttpRequest,
  HttpResponse,
  HttpVerbsEnum,
} from "@frontapp/plugin-sdk";

const HTTP_GET = "GET" as HttpVerbsEnum;
const HTTP_POST = "POST" as HttpVerbsEnum;

import type { CaptureCreate, CaptureResult, JsonValue } from "@overturn-ai/shared";
import {
  type AppSettings,
  type ConversationSnapshot,
  createDraftDetector,
  customFieldsFrom,
  type DraftDetector,
  type DraftState,
  decideOnSend,
  extractBodyText,
  type FrontCommentSnapshot,
  type FrontMessageSnapshot,
  findSentMessage,
  inScope,
  statusLine,
  tagNamesFrom,
} from "./capture";

/** Minimal Front conversation surface read by the plugin. */
export interface FrontConversationLike {
  id: string;
  subject?: string;
  recipient?: {
    handle?: string;
    name?: string;
  };
  tags: ReadonlyArray<Pick<ApplicationTag, "id" | "name">>;
  customFieldAttributes: ReadonlyArray<ApplicationCustomAttribute>;
  draftId?: ApplicationDraftId;
}

/** Narrow single-conversation context matching `@frontapp/plugin-sdk`'s `WebViewContext`. */
export interface FrontSingleConversationContextLike {
  type: "singleConversation";
  teammate: {
    email: string;
    name: string;
    username: string;
  };
  conversation: FrontConversationLike;
  fetchDraft(draftId: ApplicationDraftId): Promise<ApplicationDraft | undefined>;
  listMessages(
    paginationToken?: ApplicationPaginationToken,
  ): Promise<{ results: ReadonlyArray<ApplicationMessage>; nextPageToken?: ApplicationPaginationToken }>;
  listComments(paginationToken?: ApplicationPaginationToken): Promise<{
    results: ReadonlyArray<{
      id: ApplicationCommentId;
      author: { name: string; email: string; username: string };
      content: { body: string };
      createdAt: Date;
    }>;
    nextPageToken?: ApplicationPaginationToken;
  }>;
  sendHttp?(request: HttpRequest): Promise<HttpResponse>;
}

export type FrontContextEvent = FrontSingleConversationContextLike | { type: string };

/** Narrow Front SDK bridge required by the controller (structurally satisfied by `Front`). */
export interface FrontSdkLike {
  contextUpdates: {
    subscribe(next: (context: FrontContextEvent) => void): { unsubscribe(): void };
  };
}

export interface RecordedRun {
  id: string;
  output: unknown;
  agent: string;
}

export interface OverturnTransport {
  findRecordedRun(
    externalId: string,
    agent: string,
    ctx: FrontSingleConversationContextLike,
  ): Promise<RecordedRun | null>;
  postCapture(body: CaptureCreate, ctx: FrontSingleConversationContextLike): Promise<CaptureResult>;
}

export interface HeldCapture {
  conversation: ConversationSnapshot;
  draft: DraftState;
  draftFields: Record<string, JsonValue>;
  sendMessageId?: string;
  sendText: string;
  sendFields: Record<string, JsonValue>;
  actor: string | null;
  changedFields: string[];
}

export interface PluginViewState {
  inScope: boolean;
  hasConversation: boolean;
  hasDraftId: boolean;
  needsReason: boolean;
  editPendingBeforeSend: boolean;
  statusText: string;
  noteText: string;
  noteIsError: boolean;
  reasonCode: string | null;
  reasonText: string;
}

interface ConversationSession {
  detector: DraftDetector;
  draftId: ApplicationDraftId | null;
  draftFields: Record<string, JsonValue>;
  knownMessageIds: Set<string> | null;
  runsChecked: boolean;
  heldCapture: HeldCapture | null;
  lastResult: { kind: string; changed: boolean; dedup: boolean } | null;
  note: string;
  noteIsError: boolean;
  editPendingBeforeSend: boolean;
}

export class CaptureHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface BrowserTransportOptions {
  getSettings: () => AppSettings;
  getApiKey: () => string | null;
  getProxyUrl?: () => string | null;
  useFrontRelay?: () => boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Sends Overturn API requests either via Front's authenticated `sendHttp` backend relay
 * (when configured in Front Developer Portal) or directly via `fetch` with a bearer key / proxy.
 */
export function createOverturnTransport(opts: BrowserTransportOptions): OverturnTransport {
  const fetchFn = opts.fetchImpl ?? globalThis.fetch;

  async function requestJson<T>(
    verb: HttpVerbsEnum,
    path: string,
    body: unknown,
    ctx: FrontSingleConversationContextLike,
  ): Promise<T> {
    const apiKey = opts.getApiKey()?.trim() || null;
    const proxyUrl = opts.getProxyUrl?.()?.trim().replace(/\/+$/, "") || null;
    const preferRelay = opts.useFrontRelay?.() ?? (!apiKey && !proxyUrl);

    if (preferRelay && ctx.sendHttp) {
      const res = await ctx.sendHttp({ verb, path, ...(body !== undefined ? { body } : {}) });
      if (res.status < 200 || res.status >= 300) {
        throw new CaptureHttpError(res.status, `Overturn HTTP ${res.status}`);
      }
      return res.body as T;
    }

    const base = proxyUrl ?? opts.getSettings().baseUrl;
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const res = await fetchFn(`${base}${path}`, {
      method: verb,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      throw new CaptureHttpError(res.status, `Overturn HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  return {
    async findRecordedRun(externalId, agent, ctx) {
      const query = `/v1/runs?externalId=${encodeURIComponent(externalId)}&agent=${encodeURIComponent(agent)}&limit=1`;
      try {
        const data = await requestJson<{ items: RecordedRun[] }>(HTTP_GET, query, undefined, ctx);
        return data.items[0] ?? null;
      } catch {
        return null;
      }
    },
    async postCapture(body, ctx) {
      return requestJson<CaptureResult>(HTTP_POST, "/v1/capture", body, ctx);
    },
  };
}

const MAX_MESSAGE_PAGES = 10;

async function loadAllMessages(ctx: FrontSingleConversationContextLike): Promise<FrontMessageSnapshot[]> {
  const out: FrontMessageSnapshot[] = [];
  let token: ApplicationPaginationToken | undefined;
  for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
    const res = await ctx.listMessages(token);
    for (const m of res.results) {
      out.push({
        id: m.id,
        subject: m.subject,
        date: m.date,
        status: m.status,
        content: m.content ? { body: m.content.body, type: m.content.type } : undefined,
        from: { handle: m.from.handle, name: m.from.name },
      });
    }
    if (!res.nextPageToken) break;
    token = res.nextPageToken;
  }
  return out;
}

async function loadAllComments(ctx: FrontSingleConversationContextLike): Promise<FrontCommentSnapshot[]> {
  const out: FrontCommentSnapshot[] = [];
  let token: ApplicationPaginationToken | undefined;
  for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
    const res = await ctx.listComments(token);
    for (const c of res.results) {
      out.push({
        id: c.id,
        author: { name: c.author.name, email: c.author.email, username: c.author.username },
        content: { body: c.content.body },
        createdAt: c.createdAt,
      });
    }
    if (!res.nextPageToken) break;
    token = res.nextPageToken;
  }
  return out;
}

function messageIdAsString(id: ApplicationMessageId): string {
  return id;
}

export interface ControllerOptions {
  front: FrontSdkLike;
  transport: OverturnTransport;
  getSettings: () => AppSettings;
  onStateChange: (state: PluginViewState) => void;
  onNeedReason?: (changedFields: string[]) => void;
  onCaptured?: () => void;
  pollIntervalMs?: number;
  now?: () => number;
}

export interface FrontPluginController {
  markCurrentAsDraft(): Promise<void>;
  submitHeldCapture(): Promise<void>;
  setReasonCode(code: string | null): void;
  setReasonText(text: string): void;
  refresh(): Promise<void>;
  getViewState(): PluginViewState;
  destroy(): void;
}

/**
 * Orchestrates Front sidebar context updates, draft detection, send capture, and `require_reason`
 * gating without touching DOM directly so every lifecycle path is unit-testable.
 */
export function createFrontPluginController(opts: ControllerOptions): FrontPluginController {
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollIntervalMs ?? 2000;
  const sessions = new Map<string, ConversationSession>();

  let activeCtx: FrontSingleConversationContextLike | null = null;
  let activeScoped = true;
  let reasonCode: string | null = null;
  let reasonText = "";
  let queue: Promise<void> = Promise.resolve();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let destroyed = false;

  function sessionFor(conversationId: string): ConversationSession {
    let s = sessions.get(conversationId);
    if (!s) {
      const settings = opts.getSettings();
      s = {
        detector: createDraftDetector({ minDraftChars: settings.minDraftChars }),
        draftId: null,
        draftFields: {},
        knownMessageIds: null,
        runsChecked: false,
        heldCapture: null,
        lastResult: null,
        note: "",
        noteIsError: false,
        editPendingBeforeSend: false,
      };
      sessions.set(conversationId, s);
    }
    return s;
  }

  function buildViewState(): PluginViewState {
    if (!activeCtx) {
      return {
        inScope: true,
        hasConversation: false,
        hasDraftId: false,
        needsReason: false,
        editPendingBeforeSend: false,
        statusText: "Select a conversation",
        noteText: "",
        noteIsError: false,
        reasonCode,
        reasonText,
      };
    }
    const settings = opts.getSettings();
    if (!activeScoped) {
      return {
        inScope: false,
        hasConversation: true,
        hasDraftId: false,
        needsReason: false,
        editPendingBeforeSend: false,
        statusText: `Not watching: no "${settings.scopeTag}" tag`,
        noteText: "",
        noteIsError: false,
        reasonCode,
        reasonText,
      };
    }
    const session = sessionFor(activeCtx.conversation.id);
    const held = session.heldCapture;
    const statusText = held
      ? "Pick why you changed the reply to save this correction"
      : statusLine(session.detector.current(), session.lastResult);

    return {
      inScope: true,
      hasConversation: true,
      hasDraftId: Boolean(activeCtx.conversation.draftId),
      needsReason: Boolean(held),
      editPendingBeforeSend: session.editPendingBeforeSend && !reasonCode,
      statusText,
      noteText: session.note,
      noteIsError: session.noteIsError,
      reasonCode,
      reasonText,
    };
  }

  function emit(): void {
    if (!destroyed) opts.onStateChange(buildViewState());
  }

  function stopPolling(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function ensurePolling(): void {
    if (destroyed || pollMs <= 0 || !activeCtx || !activeScoped) {
      stopPolling();
      return;
    }
    const convId = activeCtx.conversation.id;
    const session = sessionFor(convId);
    const shouldPoll = Boolean(activeCtx.conversation.draftId) && !session.heldCapture;
    if (!shouldPoll) {
      stopPolling();
      return;
    }
    if (pollTimer === null) {
      pollTimer = setInterval(() => {
        void enqueue(() => inspectActiveDraft());
      }, pollMs);
    }
  }

  function enqueue(work: () => Promise<void>): Promise<void> {
    queue = queue.then(work).catch(() => {
      // Fail open: internal sync errors must never block the UI or Front.
    });
    return queue;
  }

  async function snapshotKnownMessages(
    ctx: FrontSingleConversationContextLike,
    session: ConversationSession,
  ): Promise<void> {
    if (session.knownMessageIds !== null) return;
    try {
      const msgs = await loadAllMessages(ctx);
      session.knownMessageIds = new Set(msgs.map((m) => m.id));
    } catch {
      session.knownMessageIds = null;
    }
  }

  async function postDecisionCapture(
    body: CaptureCreate,
    session: ConversationSession,
    ctx: FrontSingleConversationContextLike,
  ): Promise<void> {
    try {
      const result = await opts.transport.postCapture(body, ctx);
      session.lastResult = { kind: result.kind, changed: result.changed, dedup: result.deduplicated };
      session.note = result.changed && result.case ? `Case: ${result.case.title}` : "";
      session.noteIsError = false;
      session.heldCapture = null;
      session.editPendingBeforeSend = false;
      session.detector.set(null);
      session.draftId = null;
      session.knownMessageIds = null;
      session.runsChecked = false;
      reasonCode = null;
      reasonText = "";
      opts.onCaptured?.();
    } catch (err) {
      const status = err instanceof CaptureHttpError ? err.status : "network";
      session.note = `Overturn could not save this correction (${status}).`;
      session.noteIsError = true;
    }
  }

  async function evaluateDraftState(
    ctx: FrontSingleConversationContextLike,
    session: ConversationSession,
  ): Promise<void> {
    const draftId = ctx.conversation.draftId;
    if (!draftId) return;
    const settings = opts.getSettings();

    // Check if an Overturn SDK agent already recorded its run for this conversation.
    if (!session.runsChecked && !session.detector.current()) {
      session.runsChecked = true;
      const recorded = await opts.transport.findRecordedRun(`fr:${ctx.conversation.id}`, settings.agent, ctx);
      if (recorded && typeof recorded.output === "string" && recorded.output.trim()) {
        session.detector.set({
          text: recorded.output,
          origin: "recorded",
          runId: recorded.id,
          at: now(),
        });
        session.draftFields = customFieldsFrom(
          ctx.conversation.customFieldAttributes,
          settings.decisionFields,
        );
        session.lastResult = null;
        await snapshotKnownMessages(ctx, session);
      }
    }

    const rawDraft = await ctx.fetchDraft(draftId);
    if (!rawDraft) return;
    const draftText = extractBodyText(rawDraft.content);
    const existing = session.detector.current();

    if (!existing) {
      const detected = session.detector.onComposer(draftText, now());
      if (detected) {
        session.draftFields = customFieldsFrom(
          ctx.conversation.customFieldAttributes,
          settings.decisionFields,
        );
        session.lastResult = null;
        session.heldCapture = null;
        session.note = "";
        session.noteIsError = false;
        await snapshotKnownMessages(ctx, session);
      }
    } else if (settings.requireReason) {
      const currentFields = customFieldsFrom(ctx.conversation.customFieldAttributes, settings.decisionFields);
      const preview = decideOnSend({
        conversation: { id: ctx.conversation.id, messages: [] },
        draft: existing,
        draftFields: session.draftFields,
        send: { text: draftText, fields: currentFields },
        reasonCode,
        reason: reasonText,
        actor: null,
        settings,
        now: now(),
      });
      session.editPendingBeforeSend = preview.action === "need-reason";
    }
  }

  async function handleDraftDisappeared(
    ctx: FrontSingleConversationContextLike,
    session: ConversationSession,
  ): Promise<void> {
    const draft = session.detector.current();
    session.draftId = null;
    if (!draft) {
      session.runsChecked = false;
      session.knownMessageIds = null;
      return;
    }

    // Only read thread messages after a draft actually appeared and cleared.
    const settings = opts.getSettings();
    const messages = await loadAllMessages(ctx);
    const sent = findSentMessage(messages, {
      knownMessageIds: session.knownMessageIds,
      draftAt: draft.at,
    });

    if (!sent) {
      // Draft was discarded rather than sent.
      session.detector.set(null);
      session.knownMessageIds = null;
      session.runsChecked = false;
      session.editPendingBeforeSend = false;
      return;
    }

    const comments = settings.captureInternalNotes ? await loadAllComments(ctx) : undefined;
    const sendFields = customFieldsFrom(ctx.conversation.customFieldAttributes, settings.decisionFields);
    const conversation: ConversationSnapshot = {
      id: ctx.conversation.id,
      subject: ctx.conversation.subject,
      recipient: ctx.conversation.recipient
        ? { handle: ctx.conversation.recipient.handle, name: ctx.conversation.recipient.name }
        : undefined,
      tags: ctx.conversation.tags,
      customFieldAttributes: ctx.conversation.customFieldAttributes,
      messages,
      comments,
    };
    const sendText = extractBodyText(sent.content);
    const sendId = messageIdAsString(sent.id as ApplicationMessageId);
    const actor = ctx.teammate.email || ctx.teammate.username || null;

    const decision = decideOnSend({
      conversation,
      draft,
      draftFields: session.draftFields,
      send: { messageId: sendId, text: sendText, fields: sendFields },
      reasonCode,
      reason: reasonText,
      actor,
      settings,
      now: now(),
    });

    if (decision.action === "skip") {
      session.detector.set(null);
      session.knownMessageIds = null;
      session.runsChecked = false;
      session.editPendingBeforeSend = false;
      return;
    }

    if (decision.action === "need-reason") {
      session.heldCapture = {
        conversation,
        draft,
        draftFields: session.draftFields,
        sendMessageId: sendId,
        sendText,
        sendFields,
        actor,
        changedFields: decision.changedFields,
      };
      session.note = `Overturn: pick why you changed the ${decision.changedFields.length ? decision.changedFields.join(", ") : "reply"}, then click Save capture.`;
      session.noteIsError = true;
      opts.onNeedReason?.(decision.changedFields);
      return;
    }

    await postDecisionCapture(decision.body, session, ctx);
  }

  async function inspectActiveDraft(): Promise<void> {
    if (!activeCtx || !activeScoped) return;
    const session = sessionFor(activeCtx.conversation.id);
    if (activeCtx.conversation.draftId) {
      await evaluateDraftState(activeCtx, session);
      emit();
    }
  }

  async function handleContextUpdate(rawCtx: FrontContextEvent): Promise<void> {
    if (rawCtx.type !== "singleConversation") {
      activeCtx = null;
      activeScoped = true;
      stopPolling();
      emit();
      return;
    }

    const ctx = rawCtx as FrontSingleConversationContextLike;
    activeCtx = ctx;
    const settings = opts.getSettings();
    activeScoped = inScope(tagNamesFrom(ctx.conversation.tags), settings);

    if (!activeScoped) {
      stopPolling();
      emit();
      return;
    }

    const session = sessionFor(ctx.conversation.id);
    if (ctx.conversation.draftId) {
      if (session.draftId !== ctx.conversation.draftId) {
        session.draftId = ctx.conversation.draftId;
      }
      await evaluateDraftState(ctx, session);
    } else if (session.draftId !== null || session.detector.current() !== null) {
      await handleDraftDisappeared(ctx, session);
    }

    ensurePolling();
    emit();
  }

  const sub = opts.front.contextUpdates.subscribe((ctx) => {
    void enqueue(() => handleContextUpdate(ctx));
  });

  emit();

  return {
    async markCurrentAsDraft() {
      await enqueue(async () => {
        if (!activeCtx || !activeScoped) return;
        const session = sessionFor(activeCtx.conversation.id);
        const draftId = activeCtx.conversation.draftId;
        if (!draftId) {
          session.note = "Open a reply draft in Front first.";
          session.noteIsError = false;
          emit();
          return;
        }
        const rawDraft = await activeCtx.fetchDraft(draftId);
        const text = rawDraft ? extractBodyText(rawDraft.content) : "";
        if (!text) {
          session.note = "The active draft is empty.";
          session.noteIsError = false;
          emit();
          return;
        }
        const settings = opts.getSettings();
        session.draftId = draftId;
        session.detector.set({ text, origin: "manual", at: now() });
        session.draftFields = customFieldsFrom(
          activeCtx.conversation.customFieldAttributes,
          settings.decisionFields,
        );
        session.lastResult = null;
        session.heldCapture = null;
        session.editPendingBeforeSend = false;
        session.note = "";
        session.noteIsError = false;
        await snapshotKnownMessages(activeCtx, session);
        ensurePolling();
        emit();
      });
    },

    async submitHeldCapture() {
      await enqueue(async () => {
        if (!activeCtx || !activeScoped) return;
        const session = sessionFor(activeCtx.conversation.id);
        const held = session.heldCapture;
        if (!held) return;

        const settings = opts.getSettings();
        const decision = decideOnSend({
          conversation: held.conversation,
          draft: held.draft,
          draftFields: held.draftFields,
          send: {
            messageId: held.sendMessageId,
            text: held.sendText,
            fields: held.sendFields,
          },
          reasonCode,
          reason: reasonText,
          actor: held.actor,
          settings,
          now: now(),
        });

        if (decision.action === "need-reason") {
          session.note = `Overturn: pick why you changed the ${decision.changedFields.length ? decision.changedFields.join(", ") : "reply"}, then click Save capture.`;
          session.noteIsError = true;
          opts.onNeedReason?.(decision.changedFields);
          emit();
          return;
        }

        if (decision.action === "capture") {
          await postDecisionCapture(decision.body, session, activeCtx);
          ensurePolling();
          emit();
        }
      });
    },

    setReasonCode(code) {
      reasonCode = code;
      emit();
    },

    setReasonText(text) {
      reasonText = text;
    },

    async refresh() {
      await enqueue(async () => {
        await inspectActiveDraft();
      });
    },

    getViewState() {
      return buildViewState();
    },

    destroy() {
      destroyed = true;
      stopPolling();
      sub.unsubscribe();
    },
  };
}
