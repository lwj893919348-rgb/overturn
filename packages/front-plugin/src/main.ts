import Front from "@frontapp/plugin-sdk";
import { type AppSettings, quickReasons, settingsFrom } from "./capture";
import { createFrontPluginController, createOverturnTransport, type PluginViewState } from "./plugin";

const STORAGE_KEY = "overturn.frontPlugin.config.v1";

interface StoredConfig {
  overturn_api_key?: string;
  overturn_base_url?: string;
  overturn_proxy_url?: string;
  use_front_relay?: boolean;
  agent?: string;
  reason_pack?: string;
  require_reason?: boolean;
  capture_internal_notes?: boolean;
  decision_fields?: string;
  scope_tag?: string;
  min_draft_chars?: string;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function queryConfigFromLocation(): StoredConfig {
  const params = new URLSearchParams(window.location.search);
  const pick = (k: string): string | undefined => {
    const v = params.get(k);
    return v?.trim() ? v.trim() : undefined;
  };
  const cfg: StoredConfig = {};
  const baseUrl = pick("overturn_base_url");
  const proxyUrl = pick("overturn_proxy_url");
  const agent = pick("agent");
  const reasonPack = pick("reason_pack");
  const reqReason = pick("require_reason");
  const internalNotes = pick("capture_internal_notes");
  const decisionFields = pick("decision_fields");
  const scopeTag = pick("scope_tag");
  const minDraftChars = pick("min_draft_chars");
  const relay = pick("use_front_relay");

  if (baseUrl) cfg.overturn_base_url = baseUrl;
  if (proxyUrl) cfg.overturn_proxy_url = proxyUrl;
  if (agent) cfg.agent = agent;
  if (reasonPack) cfg.reason_pack = reasonPack;
  if (reqReason !== undefined) cfg.require_reason = reqReason === "true" || reqReason === "1";
  if (internalNotes !== undefined)
    cfg.capture_internal_notes = internalNotes === "true" || internalNotes === "1";
  if (decisionFields) cfg.decision_fields = decisionFields;
  if (scopeTag) cfg.scope_tag = scopeTag;
  if (minDraftChars) cfg.min_draft_chars = minDraftChars;
  if (relay !== undefined) cfg.use_front_relay = relay === "true" || relay === "1";
  return cfg;
}

function loadStoredConfig(): StoredConfig {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as StoredConfig) : {};
  } catch {
    return {};
  }
}

function saveStoredConfig(cfg: StoredConfig): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    // storage may be restricted in sandboxed iframes
  }
}

function main(): void {
  const root = document.getElementById("app");
  if (!root) return;

  let stored: StoredConfig = { ...queryConfigFromLocation(), ...loadStoredConfig() };
  let settings: AppSettings = settingsFrom(stored as Record<string, unknown>);

  const status = el("div", { class: "status" }, "Select a conversation");
  const quick = el("div", { class: "quick", role: "radiogroup", "aria-label": "Why did you change it?" });
  const reason = el("textarea", {
    class: "reason",
    rows: "2",
    placeholder: "Anything else? Optional.",
  });
  const saveCaptureBtn = el("button", { type: "button", class: "primary hidden" }, "Save capture");
  const markBtn = el("button", { type: "button", class: "link" }, "Use the current text as the draft");
  const actions = el("div", { class: "actions" });
  actions.append(saveCaptureBtn, markBtn);
  const note = el("div", { class: "note" }, "");

  // Collapsible settings drawer for direct API key / workflow configuration.
  const settingsWrap = el("div", { class: "settings" });
  const toggleSettingsBtn = el("button", { type: "button", class: "link" }, "Settings");
  const settingsPanel = el("div", { class: "settings-grid hidden" });

  const apiKeyInput = el("input", {
    type: "password",
    placeholder: "ov_live_... (leave blank when using Front relay)",
    value: stored.overturn_api_key ?? "",
  });
  const baseUrlInput = el("input", {
    type: "url",
    value: settings.baseUrl,
  });
  const agentInput = el("input", {
    type: "text",
    value: settings.agent,
  });
  const packSelect = el("select");
  packSelect.append(
    el("option", { value: "support" }, "support"),
    el("option", { value: "claims" }, "claims"),
  );
  packSelect.value = settings.reasonPack;

  const requireReasonCheck = el("input", { type: "checkbox" });
  requireReasonCheck.checked = settings.requireReason;

  const scopeTagInput = el("input", {
    type: "text",
    placeholder: "Optional tag (e.g. ai_drafted)",
    value: settings.scopeTag ?? "",
  });
  const decisionFieldsInput = el("input", {
    type: "text",
    placeholder: "Optional: status, reserve",
    value: stored.decision_fields ?? "",
  });
  const saveSettingsBtn = el("button", { type: "button", class: "primary" }, "Save settings");

  const wrapField = (label: string, input: HTMLElement): HTMLLabelElement => {
    const lbl = el("label", { class: "field" });
    lbl.append(el("span", {}, label), input);
    return lbl;
  };
  const reqLabel = el("label", { class: "check" });
  reqLabel.append(requireReasonCheck, el("span", {}, "Require reason for changed replies"));

  settingsPanel.append(
    wrapField("Overturn API key", apiKeyInput),
    wrapField("Overturn API URL", baseUrlInput),
    wrapField("Workflow (agent)", agentInput),
    wrapField("Reason pack", packSelect),
    wrapField("Scope tag", scopeTagInput),
    wrapField("Decision fields", decisionFieldsInput),
    reqLabel,
    saveSettingsBtn,
  );
  settingsWrap.append(toggleSettingsBtn, settingsPanel);
  root.append(status, quick, reason, actions, note, settingsWrap);

  let chips: HTMLButtonElement[] = [];
  let controllerRef: ReturnType<typeof createFrontPluginController> | null = null;

  function renderChips(activeCode: string | null): void {
    quick.replaceChildren();
    chips = [];
    for (const q of quickReasons(settings)) {
      const b = el("button", { type: "button", class: "chip", "data-code": q.code }, q.label);
      b.classList.toggle("on", activeCode === q.code);
      b.addEventListener("click", () => {
        const next = controllerRef?.getViewState().reasonCode === q.code ? null : q.code;
        controllerRef?.setReasonCode(next);
      });
      chips.push(b);
      quick.appendChild(b);
    }
  }

  function renderView(state: PluginViewState): void {
    status.textContent = state.statusText;
    status.classList.toggle("warn", state.needsReason || state.editPendingBeforeSend);

    const showControls = state.inScope && state.hasConversation;
    quick.classList.toggle("hidden", !showControls);
    reason.classList.toggle("hidden", !showControls);
    actions.classList.toggle("hidden", !showControls);

    saveCaptureBtn.classList.toggle("hidden", !state.needsReason);
    markBtn.classList.toggle("hidden", !state.hasDraftId || state.needsReason);

    for (const c of chips) {
      c.classList.toggle("on", c.dataset.code === state.reasonCode);
    }
    if (reason.value !== state.reasonText) {
      reason.value = state.reasonText;
    }
    note.textContent = state.noteText;
    note.classList.toggle("error", state.noteIsError);
  }

  const transport = createOverturnTransport({
    getSettings: () => settings,
    getApiKey: () => stored.overturn_api_key?.trim() || null,
    getProxyUrl: () => stored.overturn_proxy_url?.trim() || null,
    useFrontRelay: () =>
      stored.use_front_relay ?? (!stored.overturn_api_key?.trim() && !stored.overturn_proxy_url?.trim()),
  });

  const controller = createFrontPluginController({
    front: Front,
    transport,
    getSettings: () => settings,
    onStateChange: renderView,
    onNeedReason: () => {
      chips[0]?.focus();
    },
    onCaptured: () => {
      reason.value = "";
    },
  });
  controllerRef = controller;
  renderChips(null);

  reason.addEventListener("input", () => {
    controller.setReasonText(reason.value);
  });
  markBtn.addEventListener("click", () => {
    void controller.markCurrentAsDraft();
  });
  saveCaptureBtn.addEventListener("click", () => {
    void controller.submitHeldCapture();
  });
  toggleSettingsBtn.addEventListener("click", () => {
    settingsPanel.classList.toggle("hidden");
  });
  saveSettingsBtn.addEventListener("click", () => {
    stored = {
      ...stored,
      overturn_api_key: apiKeyInput.value.trim() || undefined,
      overturn_base_url: baseUrlInput.value.trim() || undefined,
      agent: agentInput.value.trim() || undefined,
      reason_pack: packSelect.value,
      require_reason: requireReasonCheck.checked,
      scope_tag: scopeTagInput.value.trim() || undefined,
      decision_fields: decisionFieldsInput.value.trim() || undefined,
    };
    saveStoredConfig(stored);
    settings = settingsFrom(stored as Record<string, unknown>);
    renderChips(controller.getViewState().reasonCode);
    settingsPanel.classList.add("hidden");
    void controller.refresh();
  });
}

main();
