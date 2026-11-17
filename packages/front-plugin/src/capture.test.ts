import { captureCreateSchema } from "@overturn-ai/shared";
import { describe, expect, it } from "vitest";
import {
  type ConversationSnapshot,
  contextFrom,
  createDraftDetector,
  customFieldsFrom,
  DEFAULT_SETTINGS,
  decideOnSend,
  extractBodyText,
  findSentMessage,
  inScope,
  quickReasons,
  settingsFrom,
  statusLine,
  stripHtml,
  tagNamesFrom,
} from "./capture";

const draftHtml =
  "<p>Hi Dana,</p><p>Thanks for the photos. Storm damage to the roof is covered under your HO-3 policy. An adjuster will contact you within 5 business days.</p>";

const conversation: ConversationSnapshot = {
  id: "cnv_48213",
  subject: "Roof leak after storm",
  recipient: { handle: "dana@example.com", name: "Dana" },
  tags: [{ id: "tag_1", name: "claims" }],
  customFieldAttributes: [
    { id: "cf_status", name: "status", type: "enum", value: "covered" },
    { id: "cf_reserve", name: "reserve", type: "number", value: 4000 },
  ],
  messages: [
    {
      id: "msg_1",
      date: new Date("2026-10-01T10:00:00Z"),
      status: "inbound",
      content: { body: "<div>Water came through the ceiling.<br>Photos attached.</div>", type: "html" },
      from: { handle: "dana@example.com", name: "Dana" },
    },
    {
      id: "msg_2",
      date: new Date("2026-10-01T11:00:00Z"),
      status: "outbound",
      content: { body: "Thanks, reviewing your photos now.", type: "text" },
      from: { handle: "ray@carrier.com", name: "Ray" },
    },
  ],
  comments: [
    {
      id: "cmt_1",
      author: { name: "Ray", email: "ray@carrier.com", username: "ray" },
      content: { body: "HO-3, no prior claims." },
      createdAt: new Date("2026-10-01T10:30:00Z"),
    },
  ],
  url: "https://app.frontapp.com/open/cnv_48213",
};

describe("settings", () => {
  it("parses parameters and strips trailing slashes", () => {
    const s = settingsFrom({
      overturn_base_url: "https://ov.internal/",
      agent: "claims-reply",
      require_reason: "true",
      capture_internal_notes: "1",
      decision_fields: "cf_status:status, cf_reserve:reserve,severity",
      min_draft_chars: "120",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.agent).toBe("claims-reply");
    expect(s.requireReason).toBe(true);
    expect(s.captureInternalNotes).toBe(true);
    expect(s.decisionFields).toEqual([
      { id: "cf_status", label: "status" },
      { id: "cf_reserve", label: "reserve" },
      { id: "severity", label: "severity" },
    ]);
    expect(s.minDraftChars).toBe(120);
  });

  it("scope_tag limits which conversations are watched", () => {
    expect(inScope(["billing"], DEFAULT_SETTINGS)).toBe(true);
    const scoped = settingsFrom({ scope_tag: "ai_drafted" });
    expect(scoped.scopeTag).toBe("ai_drafted");
    expect(inScope(["billing"], scoped)).toBe(false);
    expect(inScope(["billing", "ai_drafted"], scoped)).toBe(true);
    expect(tagNamesFrom(conversation.tags)).toEqual(["claims"]);
  });

  it("reason_pack picks support by default and claims when configured", () => {
    expect(quickReasons(DEFAULT_SETTINGS).map((r) => r.code)).toContain("wrong_answer");
    const claims = settingsFrom({ reason_pack: "claims" });
    const claimsCodes = quickReasons(claims).map((r) => r.code);
    expect(claimsCodes).toHaveLength(8);
    expect(claimsCodes).toContain("wrong_coverage_decision");
    expect(claimsCodes).toContain("tone_wording");
    expect(settingsFrom({ reason_pack: "invalid" }).reasonPack).toBe("support");
  });

  it("falls back to defaults with require_reason on", () => {
    expect(settingsFrom({})).toEqual(DEFAULT_SETTINGS);
    expect(settingsFrom({ require_reason: "false" }).requireReason).toBe(false);
  });
});

describe("draft detection", () => {
  const long = "x".repeat(200);

  it("detects a reply-sized insert into an empty draft, while ignoring manual typing", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    expect(d.onComposer("", 0)).toBeNull();
    let text = "";
    for (let i = 1; i <= 100; i++) {
      text += "ab";
      expect(d.onComposer(text, i * 100)).toBeNull();
    }
    expect(d.current()).toBeNull();

    const d2 = createDraftDetector({ minDraftChars: 80 });
    d2.onComposer("", 0);
    expect(d2.onComposer(long, 500)?.origin).toBe("inserted");
    expect(d2.onComposer(`${long} more`, 600)).toBeNull();
  });

  it("marks an already-populated draft on first sight as preloaded", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    expect(d.onComposer(long, 10)?.origin).toBe("preloaded");
  });

  it("detects a paste after typing a short greeting", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    d.onComposer("", 0);
    d.onComposer("Hi Dana,", 1000);
    expect(d.onComposer(`Hi Dana,\n${long}`, 9000)?.origin).toBe("inserted");
  });
});

describe("context, html, and custom fields", () => {
  it("strips html and formats chronological context excluding the newly sent message", () => {
    expect(stripHtml("<p>a&nbsp;b</p><p>c<br>d</p>")).toBe("a b\nc\nd");
    expect(extractBodyText({ body: "<p>Hello &amp; welcome</p>", type: "html" })).toBe("Hello & welcome");
    expect(extractBodyText({ body: "Plain   text", type: "text" })).toBe("Plain text");

    const ctx = contextFrom(conversation, {
      excludeMessageId: "msg_2",
      captureInternalNotes: true,
    });
    expect(ctx).toEqual([
      {
        role: "customer",
        author: "dana@example.com",
        content: "Water came through the ceiling.\nPhotos attached.",
        at: "2026-10-01T10:00:00.000Z",
      },
      {
        role: "note",
        author: "ray@carrier.com",
        content: "HO-3, no prior claims.",
        at: "2026-10-01T10:30:00.000Z",
      },
    ]);
  });

  it("maps custom field attributes by id or name and serializes dates", () => {
    const dt = new Date("2026-11-01T00:00:00Z");
    const fields = customFieldsFrom(
      [
        { id: "cf_1", name: "Reserve", type: "number", value: 6500 },
        { id: "cf_2", name: "Loss Date", type: "datetime", value: dt },
      ],
      [
        { id: "cf_1", label: "reserve" },
        { id: "loss date", label: "loss_date" },
        { id: "missing", label: "denial_reason" },
      ],
    );
    expect(fields).toEqual({
      reserve: 6500,
      loss_date: "2026-11-01T00:00:00.000Z",
      denial_reason: null,
    });
  });

  it("finds a newly sent outbound message and returns null when a draft was discarded", () => {
    const known = new Set(["msg_1", "msg_2"]);
    expect(findSentMessage(conversation.messages, { knownMessageIds: known, draftAt: 1 })).toBeNull();

    const withNew = [
      ...conversation.messages,
      {
        id: "msg_3",
        date: new Date("2026-10-01T12:00:00Z"),
        status: "outbound",
        content: { body: "Sent reply", type: "text" as const },
        from: { handle: "ray@carrier.com" },
      },
    ];
    expect(findSentMessage(withNew, { knownMessageIds: known, draftAt: 1 })?.id).toBe("msg_3");

    // Timestamp fallback when knownMessageIds wasn't available
    const draftAt = Date.parse("2026-10-01T11:55:00Z");
    expect(findSentMessage(conversation.messages, { draftAt })?.id).toBeUndefined();
    expect(findSentMessage(withNew, { draftAt })?.id).toBe("msg_3");
  });
});

describe("decideOnSend", () => {
  const draft = { text: stripHtml(draftHtml), origin: "inserted" as const, at: 1_000 };
  const base = {
    conversation,
    draft,
    draftFields: {},
    reasonCode: null as string | null,
    reason: "",
    actor: "ray@carrier.com",
    settings: { ...DEFAULT_SETTINGS, requireReason: false },
    now: 5_000,
  };

  it("skips when there is no draft or sent text is empty", () => {
    expect(decideOnSend({ ...base, draft: null, send: { text: "hello", fields: {} } })).toEqual({
      action: "skip",
      why: "no-draft",
    });
    expect(decideOnSend({ ...base, send: { text: "   ", fields: {} } })).toEqual({
      action: "skip",
      why: "empty",
    });
  });

  it("emits a valid captureCreateSchema payload with source front and fr:<id>", () => {
    const d = decideOnSend({
      ...base,
      send: { messageId: "msg_2", text: stripHtml(draftHtml), fields: {} },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(false);
    expect(d.body.source).toBe("front");
    expect(d.body.externalId).toBe("fr:cnv_48213");
    expect(d.body.tags).toEqual(["draft:inserted", "public-reply"]);
    expect(d.body.context).toHaveLength(1);
    expect(() => captureCreateSchema.parse(d.body)).not.toThrow();
  });

  it("captures edited replies with reason and reasonCode", () => {
    const sent = stripHtml(draftHtml).replace("5 business days", "2 business days");
    const d = decideOnSend({
      ...base,
      reasonCode: "wrong_amount_or_date",
      reason: "Storm SLA is 2 days",
      send: { messageId: "msg_2", text: sent, fields: {} },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.body.reasonCode).toBe("wrong_amount_or_date");
    expect(d.body.reason).toBe("Storm SLA is 2 days");
    expect(d.body.sent.text).toContain("2 business days");
    expect(() => captureCreateSchema.parse(d.body)).not.toThrow();
  });

  it("enforces require_reason on changed replies", () => {
    const sent = stripHtml(draftHtml).replace("covered", "not covered");
    const blocked = decideOnSend({
      ...base,
      settings: DEFAULT_SETTINGS,
      send: { text: sent, fields: {} },
    });
    expect(blocked).toEqual({ action: "need-reason", changedFields: [] });

    const noteOnly = decideOnSend({
      ...base,
      settings: DEFAULT_SETTINGS,
      reason: "policy exclusion",
      send: { text: sent, fields: {} },
    });
    expect(noteOnly.action).toBe("need-reason");

    const ok = decideOnSend({
      ...base,
      settings: DEFAULT_SETTINGS,
      reasonCode: "against_policy",
      send: { text: sent, fields: {} },
    });
    expect(ok.action).toBe("capture");
    if (ok.action === "capture") expect(ok.body.reasonCode).toBe("against_policy");
  });

  it("includes decision fields and detects field-only changes", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      decisionFields: [{ id: "cf_status", label: "status" }],
    };
    const d = decideOnSend({
      ...base,
      settings,
      reasonCode: "wrong_answer",
      draftFields: { status: "covered" },
      send: { text: stripHtml(draftHtml), fields: { status: "denied" } },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.changedFields).toEqual(["status"]);
    expect(d.body.draft.fields).toEqual({ status: "covered" });
    expect(d.body.sent.fields).toEqual({ status: "denied" });
    expect(() => captureCreateSchema.parse(d.body)).not.toThrow();
  });

  it("attaches recorded runId and computes secondsToSend", () => {
    const d = decideOnSend({
      ...base,
      draft: {
        text: stripHtml(draftHtml),
        origin: "recorded",
        runId: "0199a0d0-0000-7000-8000-000000000000",
        model: "gpt-4.1-mini",
        at: 10_000,
      },
      now: 14_250,
      send: { text: stripHtml(draftHtml), fields: {} },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.draftRunId).toBe("0199a0d0-0000-7000-8000-000000000000");
    expect(d.body.draftModel).toBe("gpt-4.1-mini");
    expect(d.body.secondsToSend).toBe(4.3);
    expect(() => captureCreateSchema.parse(d.body)).not.toThrow();
  });
});

describe("statusLine", () => {
  it("formats status lines matching Overturn copy", () => {
    expect(statusLine(null, null)).toBe("Waiting for a draft");
    expect(statusLine({ text: "one two three", origin: "inserted", at: 1 }, null)).toBe(
      "Draft inserted · 3 words",
    );
    expect(statusLine({ text: "one two", origin: "manual", at: 1 }, null)).toBe(
      "Draft marked by you · 2 words",
    );
    expect(statusLine(null, { kind: "approve", changed: false, dedup: false })).toBe(
      "Sent as drafted · approved",
    );
    expect(statusLine(null, { kind: "edit", changed: true, dedup: false })).toBe(
      "Captured · edit saved as a case",
    );
    expect(statusLine(null, { kind: "edit", changed: true, dedup: true })).toBe(
      "Captured · already in the suite",
    );
  });
});
