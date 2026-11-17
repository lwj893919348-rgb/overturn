import type {
  ApplicationDraft,
  ApplicationDraftId,
  ApplicationMessage,
  ApplicationMessageId,
  HttpRequest,
  HttpResponse,
} from "@frontapp/plugin-sdk";
import type { CaptureCreate, CaptureResult } from "@overturn-ai/shared";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, settingsFrom } from "./capture";
import {
  CaptureHttpError,
  createFrontPluginController,
  createOverturnTransport,
  type FrontContextEvent,
  type FrontSdkLike,
  type FrontSingleConversationContextLike,
  type OverturnTransport,
  type PluginViewState,
} from "./plugin";

const LONG_DRAFT =
  "Hi Dana, thanks for reaching out. Your storm damage claim is covered under your HO-3 policy and an adjuster will contact you within 5 business days.";

function makeDraft(body: string, id = "drf_1"): ApplicationDraft {
  return {
    id: id as ApplicationDraftId,
    channel: {} as ApplicationDraft["channel"],
    to: [],
    cc: undefined,
    bcc: undefined,
    subject: "Roof leak after storm",
    content: { body, type: "html", attachments: [] },
    isEditable: true,
  };
}

function makeMessage(opts: {
  id: string;
  status: "inbound" | "outbound";
  body: string;
  date: Date;
  handle?: string;
}): ApplicationMessage {
  return {
    id: opts.id as ApplicationMessageId,
    subject: "Roof leak after storm",
    date: opts.date,
    status: opts.status,
    content: { body: opts.body, type: "text", attachments: [] },
    rfc5322MessageId: undefined,
    from: { handle: opts.handle ?? "dana@example.com", name: undefined, contact: undefined, type: "email" },
    replyTo: undefined,
    to: [],
    cc: undefined,
    bcc: undefined,
  };
}

function createMockFront() {
  let listener: ((ctx: FrontContextEvent) => void) | null = null;
  const front: FrontSdkLike = {
    contextUpdates: {
      subscribe(next) {
        listener = next;
        return {
          unsubscribe() {
            listener = null;
          },
        };
      },
    },
  };
  const emit = async (ctx: FrontContextEvent): Promise<void> => {
    listener?.(ctx);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { front, emit };
}

function makeConversationContext(opts: {
  id?: string;
  draftId?: string;
  tags?: string[];
  fetchDraft?: FrontSingleConversationContextLike["fetchDraft"];
  listMessages?: FrontSingleConversationContextLike["listMessages"];
  listComments?: FrontSingleConversationContextLike["listComments"];
}): FrontSingleConversationContextLike {
  return {
    type: "singleConversation",
    teammate: { email: "ray@carrier.com", name: "Ray", username: "ray" },
    conversation: {
      id: opts.id ?? "cnv_100",
      subject: "Roof leak",
      recipient: { handle: "dana@example.com", name: "Dana" },
      tags: (opts.tags ?? []).map((name, i) => ({ id: `tag_${i}` as never, name })),
      customFieldAttributes: [],
      draftId: opts.draftId as ApplicationDraftId | undefined,
    },
    fetchDraft: opts.fetchDraft ?? vi.fn(async () => undefined),
    listMessages: opts.listMessages ?? vi.fn(async () => ({ results: [], nextPageToken: undefined })),
    listComments: opts.listComments ?? vi.fn(async () => ({ results: [], nextPageToken: undefined })),
  };
}

function captureOkResult(changed: boolean, dedup = false): CaptureResult {
  return {
    runId: "0199a0d0-0000-7000-8000-000000000001",
    stepId: "0199a0d0-0000-7000-8000-000000000002",
    kind: changed ? "edit" : "approve",
    changed,
    changedFields: [],
    correction: {
      id: "0199a0d0-0000-7000-8000-000000000003",
      projectId: "0199a0d0-0000-7000-8000-000000000004",
      runId: "0199a0d0-0000-7000-8000-000000000001",
      stepId: "0199a0d0-0000-7000-8000-000000000002",
      kind: changed ? "edit" : "approve",
      correctedOutput: null,
      note: null,
      reasonCode: null,
      actor: "ray@carrier.com",
      source: "capture",
      createdAt: "2026-11-16T00:00:00Z",
    },
    case: changed
      ? {
          id: "0199a0d0-0000-7000-8000-000000000005",
          projectId: "0199a0d0-0000-7000-8000-000000000004",
          correctionId: "0199a0d0-0000-7000-8000-000000000003",
          runId: "0199a0d0-0000-7000-8000-000000000001",
          stepId: "0199a0d0-0000-7000-8000-000000000002",
          agent: "support-reply",
          agentVersion: null,
          kind: "edit",
          title: "Storm SLA is 2 days",
          frozenInput: { name: "draft", provider: null, model: null, params: null },
          toolRecordings: {},
          originalOutput: null,
          expected: null,
          scorer: "judge",
          scorerConfig: {},
          tags: [],
          status: "active",
          truncated: false,
          contract: [],
          recordedModel: null,
          lastVerdict: null,
          duplicates: dedup ? 2 : 1,
          lastSeenAt: null,
          note: null,
          actor: "ray@carrier.com",
          createdAt: "2026-11-16T00:00:00Z",
        }
      : null,
    deduplicated: dedup,
  };
}

describe("front plugin controller", () => {
  it("never reads conversation messages, drafts, or runs when no draft exists", async () => {
    const { front, emit } = createMockFront();
    const fetchDraft = vi.fn(async () => undefined);
    const listMessages = vi.fn(async () => ({ results: [], nextPageToken: undefined }));
    const listComments = vi.fn(async () => ({ results: [], nextPageToken: undefined }));
    const findRecordedRun = vi.fn(async () => null);
    const postCapture = vi.fn(async () => captureOkResult(false));

    const states: PluginViewState[] = [];
    const ctrl = createFrontPluginController({
      front,
      transport: { findRecordedRun, postCapture },
      getSettings: () => DEFAULT_SETTINGS,
      onStateChange: (s) => states.push(s),
      pollIntervalMs: 0,
    });

    await emit(makeConversationContext({ draftId: undefined, fetchDraft, listMessages, listComments }));
    expect(fetchDraft).not.toHaveBeenCalled();
    expect(listMessages).not.toHaveBeenCalled();
    expect(listComments).not.toHaveBeenCalled();
    expect(findRecordedRun).not.toHaveBeenCalled();
    expect(postCapture).not.toHaveBeenCalled();
    expect(ctrl.getViewState().statusText).toBe("Waiting for a draft");
    ctrl.destroy();
  });

  it("never reads out-of-scope conversations even when a draft exists", async () => {
    const { front, emit } = createMockFront();
    const fetchDraft = vi.fn(async () => makeDraft(`<p>${LONG_DRAFT}</p>`));
    const listMessages = vi.fn(async () => ({ results: [], nextPageToken: undefined }));
    const findRecordedRun = vi.fn(async () => null);
    const postCapture = vi.fn(async () => captureOkResult(false));

    const ctrl = createFrontPluginController({
      front,
      transport: { findRecordedRun, postCapture },
      getSettings: () => settingsFrom({ scope_tag: "ai_drafted" }),
      onStateChange: () => {},
      pollIntervalMs: 0,
    });

    await emit(makeConversationContext({ draftId: "drf_1", tags: ["vip"], fetchDraft, listMessages }));
    expect(ctrl.getViewState().inScope).toBe(false);
    expect(fetchDraft).not.toHaveBeenCalled();
    expect(listMessages).not.toHaveBeenCalled();
    expect(findRecordedRun).not.toHaveBeenCalled();
    ctrl.destroy();
  });

  it("detects a draft, shows word count, and captures an unchanged send as approve", async () => {
    const { front, emit } = createMockFront();
    const inbound = makeMessage({
      id: "msg_1",
      status: "inbound",
      body: "Is roof damage covered?",
      date: new Date("2026-11-16T10:00:00Z"),
    });
    const sent = makeMessage({
      id: "msg_2",
      status: "outbound",
      body: LONG_DRAFT,
      date: new Date("2026-11-16T10:05:00Z"),
      handle: "ray@carrier.com",
    });

    let messages = [inbound];
    const listMessages = vi.fn(async () => ({ results: messages, nextPageToken: undefined }));
    const fetchDraft = vi.fn(async () => makeDraft(`<p>${LONG_DRAFT}</p>`));
    const posted: CaptureCreate[] = [];
    const transport: OverturnTransport = {
      findRecordedRun: vi.fn(async () => null),
      postCapture: vi.fn(async (body) => {
        posted.push(body);
        return captureOkResult(false);
      }),
    };

    const ctrl = createFrontPluginController({
      front,
      transport,
      getSettings: () => DEFAULT_SETTINGS,
      onStateChange: () => {},
      pollIntervalMs: 0,
      now: () => Date.parse("2026-11-16T10:04:00Z"),
    });

    await emit(makeConversationContext({ id: "cnv_200", draftId: "drf_1", fetchDraft, listMessages }));
    expect(ctrl.getViewState().statusText).toMatch(/^Draft found in the composer · \d+ words$/);

    // Simulate teammate sending the reply unchanged in Front
    messages = [inbound, sent];
    await emit(makeConversationContext({ id: "cnv_200", draftId: undefined, fetchDraft, listMessages }));

    expect(posted).toHaveLength(1);
    expect(posted[0]?.source).toBe("front");
    expect(posted[0]?.externalId).toBe("fr:cnv_200");
    expect(posted[0]?.draft.text).toBe(LONG_DRAFT);
    expect(posted[0]?.sent.text).toBe(LONG_DRAFT);
    expect(posted[0]?.context).toHaveLength(1);
    expect(posted[0]?.context[0]?.content).toBe("Is roof damage covered?");
    expect(ctrl.getViewState().statusText).toBe("Sent as drafted · approved");
    ctrl.destroy();
  });

  it("holds an edited send when require_reason is true and posts once a reason is picked", async () => {
    const { front, emit } = createMockFront();
    const inbound = makeMessage({
      id: "msg_1",
      status: "inbound",
      body: "When will an adjuster call?",
      date: new Date("2026-11-16T10:00:00Z"),
    });
    const editedBody = LONG_DRAFT.replace("5 business days", "2 business days");
    const sent = makeMessage({
      id: "msg_2",
      status: "outbound",
      body: editedBody,
      date: new Date("2026-11-16T10:05:00Z"),
      handle: "ray@carrier.com",
    });

    let messages = [inbound];
    const listMessages = vi.fn(async () => ({ results: messages, nextPageToken: undefined }));
    const fetchDraft = vi.fn(async () => makeDraft(`<p>${LONG_DRAFT}</p>`));
    const posted: CaptureCreate[] = [];
    const onNeedReason = vi.fn();

    const ctrl = createFrontPluginController({
      front,
      transport: {
        findRecordedRun: vi.fn(async () => null),
        postCapture: vi.fn(async (body) => {
          posted.push(body);
          return captureOkResult(true);
        }),
      },
      getSettings: () => settingsFrom({ reason_pack: "claims", require_reason: "true" }),
      onStateChange: () => {},
      onNeedReason,
      pollIntervalMs: 0,
      now: () => Date.parse("2026-11-16T10:04:00Z"),
    });

    await emit(makeConversationContext({ id: "cnv_300", draftId: "drf_1", fetchDraft, listMessages }));
    messages = [inbound, sent];
    await emit(makeConversationContext({ id: "cnv_300", draftId: undefined, fetchDraft, listMessages }));

    expect(posted).toHaveLength(0);
    expect(onNeedReason).toHaveBeenCalledTimes(1);
    expect(ctrl.getViewState().needsReason).toBe(true);

    ctrl.setReasonCode("wrong_amount_or_date");
    ctrl.setReasonText("Storm SLA is 2 days");
    await ctrl.submitHeldCapture();

    expect(posted).toHaveLength(1);
    expect(posted[0]?.reasonCode).toBe("wrong_amount_or_date");
    expect(posted[0]?.reason).toBe("Storm SLA is 2 days");
    expect(ctrl.getViewState().needsReason).toBe(false);
    expect(ctrl.getViewState().statusText).toBe("Captured · edit saved as a case");
    expect(ctrl.getViewState().noteText).toBe("Case: Storm SLA is 2 days");
    ctrl.destroy();
  });

  it("skips without posting when a draft is discarded rather than sent", async () => {
    const { front, emit } = createMockFront();
    const inbound = makeMessage({
      id: "msg_1",
      status: "inbound",
      body: "Hello",
      date: new Date("2026-11-16T10:00:00Z"),
    });
    const listMessages = vi.fn(async () => ({ results: [inbound], nextPageToken: undefined }));
    const fetchDraft = vi.fn(async () => makeDraft(`<p>${LONG_DRAFT}</p>`));
    const postCapture = vi.fn(async () => captureOkResult(false));

    const ctrl = createFrontPluginController({
      front,
      transport: { findRecordedRun: vi.fn(async () => null), postCapture },
      getSettings: () => DEFAULT_SETTINGS,
      onStateChange: () => {},
      pollIntervalMs: 0,
    });

    await emit(makeConversationContext({ id: "cnv_400", draftId: "drf_1", fetchDraft, listMessages }));
    // Draft discarded: draftId becomes undefined and no new outbound message exists
    await emit(makeConversationContext({ id: "cnv_400", draftId: undefined, fetchDraft, listMessages }));

    expect(postCapture).not.toHaveBeenCalled();
    expect(ctrl.getViewState().statusText).toBe("Waiting for a draft");
    ctrl.destroy();
  });

  it("fails open when Overturn capture API errors", async () => {
    const { front, emit } = createMockFront();
    const inbound = makeMessage({
      id: "msg_1",
      status: "inbound",
      body: "Hello",
      date: new Date("2026-11-16T10:00:00Z"),
    });
    const sent = makeMessage({
      id: "msg_2",
      status: "outbound",
      body: LONG_DRAFT,
      date: new Date("2026-11-16T10:05:00Z"),
    });
    let messages = [inbound];
    const listMessages = vi.fn(async () => ({ results: messages, nextPageToken: undefined }));
    const fetchDraft = vi.fn(async () => makeDraft(`<p>${LONG_DRAFT}</p>`));

    const ctrl = createFrontPluginController({
      front,
      transport: {
        findRecordedRun: vi.fn(async () => null),
        postCapture: vi.fn(async () => {
          throw new CaptureHttpError(503, "Service Unavailable");
        }),
      },
      getSettings: () => DEFAULT_SETTINGS,
      onStateChange: () => {},
      pollIntervalMs: 0,
    });

    await emit(makeConversationContext({ id: "cnv_500", draftId: "drf_1", fetchDraft, listMessages }));
    messages = [inbound, sent];
    await emit(makeConversationContext({ id: "cnv_500", draftId: undefined, fetchDraft, listMessages }));

    expect(ctrl.getViewState().noteIsError).toBe(true);
    expect(ctrl.getViewState().noteText).toContain("503");
    ctrl.destroy();
  });

  it("supports recorded SDK drafts and manual draft marking", async () => {
    const { front, emit } = createMockFront();
    const listMessages = vi.fn(async () => ({ results: [], nextPageToken: undefined }));
    const fetchDraft = vi.fn(async () => makeDraft("Short manual draft"));

    const ctrl = createFrontPluginController({
      front,
      transport: {
        findRecordedRun: vi.fn(async () => ({
          id: "0199a0d0-0000-7000-8000-000000000099",
          output: LONG_DRAFT,
          agent: "support-reply",
        })),
        postCapture: vi.fn(async () => captureOkResult(false)),
      },
      getSettings: () => DEFAULT_SETTINGS,
      onStateChange: () => {},
      pollIntervalMs: 0,
    });

    await emit(makeConversationContext({ id: "cnv_600", draftId: "drf_1", fetchDraft, listMessages }));
    expect(ctrl.getViewState().statusText).toMatch(/^Draft recorded by your agent · \d+ words$/);

    await ctrl.markCurrentAsDraft();
    expect(ctrl.getViewState().statusText).toBe("Draft marked by you · 3 words");
    ctrl.destroy();
  });
});

describe("overturn transport", () => {
  it("uses Front sendHttp relay when no client apiKey is set", async () => {
    const calls: HttpRequest[] = [];
    const ctx = makeConversationContext({});
    ctx.sendHttp = vi.fn(async (req: HttpRequest): Promise<HttpResponse> => {
      calls.push(req);
      return { status: 200, headers: {}, body: { items: [] } };
    });

    const transport = createOverturnTransport({
      getSettings: () => DEFAULT_SETTINGS,
      getApiKey: () => null,
    });
    const run = await transport.findRecordedRun("fr:cnv_1", "support-reply", ctx);
    expect(run).toBeNull();
    expect(calls[0]?.verb).toBe("GET");
    expect(calls[0]?.path).toContain("externalId=fr%3Acnv_1");
  });

  it("uses fetch with Authorization header when apiKey is configured", async () => {
    const fetchCalls: Array<{ url: string; auth?: string }> = [];
    const fetchMock: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      fetchCalls.push({ url: String(input), auth: headers.Authorization });
      return new Response(JSON.stringify(captureOkResult(false)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const transport = createOverturnTransport({
      getSettings: () => DEFAULT_SETTINGS,
      getApiKey: () => "ov_live_test123",
      fetchImpl: fetchMock,
    });
    const ctx = makeConversationContext({});
    await transport.postCapture(
      {
        source: "front",
        externalId: "fr:cnv_1",
        agent: "support-reply",
        context: [],
        draft: { text: "Hello" },
        sent: { text: "Hello" },
      },
      ctx,
    );
    expect(fetchCalls[0]?.url).toBe("https://api.overturn.run/v1/capture");
    expect(fetchCalls[0]?.auth).toBe("Bearer ov_live_test123");
  });
});
