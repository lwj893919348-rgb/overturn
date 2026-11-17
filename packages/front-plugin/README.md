# Overturn for Front

QA for AI-drafted replies inside Front's conversation sidebar. It watches the composer draft, diffs it against the outbound reply the teammate sends, asks for a one-click reason when changed, and posts the result to `POST /v1/capture`.

## What the teammate sees

- **Draft found in the composer · N words** (or **Draft inserted · N words**) once an AI assist, macro, or paste populates the draft. If the drafting agent recorded its run with the Overturn SDK (`externalId: "fr:<conversation id>"`), the draft attaches to that run (**Draft recorded by your agent · N words**). **Use the current text as the draft** marks any active draft by hand.
- **Reason picker**: one-click chips from `support` (default) or `claims`, plus an optional note.
- **On send**: sending unchanged records an `approve` capture; editing records an `edit` capture with the chosen reason. When `require_reason` is on and a changed reply is sent before picking a reason, the sidebar holds the capture until a reason chip is selected and saved. Overturn failures never block Front.
- **Privacy**: conversations with no draft (or missing `scope_tag` when set) are never read.

## Build & Test

```bash
pnpm --filter @overturn-ai/front-plugin test
pnpm --filter @overturn-ai/front-plugin typecheck
pnpm --filter @overturn-ai/front-plugin build
```

The build outputs the static plugin folder to `dist/plugin/` and the archive to `dist/overturn-front-plugin.zip`.

## Install in Front

1. Host the contents of `dist/plugin/` (or serve `dist/overturn-front-plugin.zip`) over HTTPS and add the URL as a **Sidebar plugin** entry point in the Front Developer Portal.
2. Authentication options:
   - **Recommended (server-side secret)**: configure Overturn (`https://api.overturn.run`) and your `Authorization: Bearer ov_live_...` header in the Front app's API server settings so `context.sendHttp` keeps the API key off the browser.
   - **Direct / testing**: open **Settings** in the sidebar panel and paste your Overturn project API key.
3. Optional query parameters on the plugin URL: `agent`, `reason_pack` (`support` or `claims`), `require_reason`, `capture_internal_notes`, `decision_fields` (`id:label` comma-separated), `scope_tag`, `min_draft_chars`, `overturn_base_url`.
