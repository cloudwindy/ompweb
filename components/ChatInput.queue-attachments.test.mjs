import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { clearDraft, getDraft } = await jiti.import("@/lib/draft-store");

const KEY = "queue-attachments";
// 1x1 transparent PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// Same stand-in as ChatInput.clipboard-image.test.mjs: jsdom's FileReader
// brand-checks against its own realm's Blob; the composer only needs
// readAsDataURL -> `result`.
const previousFileReader = globalThis.FileReader;
class TestFileReader {
  result = null;
  onload = null;
  onerror = null;
  readAsDataURL(blob) {
    blob.arrayBuffer().then(
      (buffer) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
        this.onload?.();
      },
      (error) => this.onerror?.(error),
    );
  }
}

const overrides = [];
function override(target, key, replacement) {
  overrides.push({ target, key, original: Object.getOwnPropertyDescriptor(target, key) });
  Object.defineProperty(target, key, { configurable: true, writable: true, value: replacement });
}

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.FileReader = TestFileReader;
  URL.createObjectURL ??= () => "blob:test";
  URL.revokeObjectURL ??= () => {};
});
afterEach(() => {
  try {
    cleanup();
  } finally {
    clearDraft(KEY);
    localStorage.clear();
    delete window.matchMedia;
    globalThis.FileReader = previousFileReader;
    while (overrides.length) {
      const { target, key, original } = overrides.pop();
      if (original) Object.defineProperty(target, key, original);
      else delete target[key];
    }
  }
});

/** A composer with an image and a text file attached through the picker path. */
async function renderWithAttachments({ queued = true, queueCallbacks = true, ...props } = {}) {
  const calls = [];
  // Images are the last argument of every queue callback, which resolves
  // false when omp refused the message.
  const record = (name) => async (message, ...rest) => {
    calls.push({ name, message, images: rest.at(-1) });
    const ok = await queued;
    return name === "onSend" ? { status: ok ? "accepted" : "rejected" } : ok;
  };
  const ref = React.createRef();
  const inputProps = {
    ref,
    draftKey: KEY,
    isStreaming: true,
    onSend: record("onSend"),
    onAbort: record("onAbort"),
    onSteer: queueCallbacks ? record("onSteer") : undefined,
    onFollowUp: queueCallbacks ? record("onFollowUp") : undefined,
    onPromptWithStreamingBehavior: queueCallbacks ? record("onPromptWithStreamingBehavior") : undefined,
    ...props,
  };
  const view = render(React.createElement(ChatInput, inputProps));
  await act(async () => {
    ref.current.addFiles([
      new File([Buffer.from(PNG, "base64")], "dot.png", { type: "image/png" }),
      new File(["hello"], "notes.txt", { type: "text/plain" }),
    ]);
  });
  await waitFor(() => {
    const draft = getDraft(KEY);
    assert.equal(draft?.images.length, 1, "the image is attached");
    assert.equal(draft?.files.length, 1);
  });
  return {
    calls,
    rerender: (changes) => view.rerender(React.createElement(ChatInput, { ...inputProps, ...changes })),
  };
}

async function renderRunningWithAttachments(options) {
  return (await renderWithAttachments(options)).calls;
}

function assertQueuedWithAttachments(call, text) {
  assert.ok(call.message.startsWith(text), "typed text leads the message");
  assert.match(call.message, /Attached file: notes\.txt\n```[^\n]*\nhello\n```/, "text file is folded in");
  assert.deepEqual(call.images?.map((image) => [image.data, image.mimeType]), [[PNG, "image/png"]]);
}

test("Enter during a run queues a follow-up with the attached image and text file, then clears them", async () => {
  const user = userEvent.setup();
  const calls = await renderRunningWithAttachments();
  await user.type(screen.getByRole("textbox"), "look at this");
  await user.keyboard("{Enter}");
  await waitFor(() => assert.equal(calls.length, 1));
  // Queueing is the default submit-during-run behavior: it is what survives a
  // `!!` shell command owning the session (see lib/rpc-manager.ts).
  assert.equal(calls[0].name, "onFollowUp", "the default submit-during-run behavior queues");
  assertQueuedWithAttachments(calls[0], "look at this");
  await waitFor(() => assert.equal(getDraft(KEY), null));
});

test("a stored Steer preference still steers Enter during a run", async () => {
  localStorage.setItem("omp-web:submit-during-run", "steer");
  const user = userEvent.setup();
  const calls = await renderRunningWithAttachments();
  await user.type(screen.getByRole("textbox"), "look at this");
  await user.keyboard("{Enter}");
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0].name, "onSteer", "an explicit stored choice stays a steer");
  assertQueuedWithAttachments(calls[0], "look at this");
});

test("attachments alone turn Stop into Queue, which queues them as a follow-up", async () => {
  const calls = await renderRunningWithAttachments();
  fireEvent.click(screen.getByRole("button", { name: /queue/i }));
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0].name, "onFollowUp");
  assertQueuedWithAttachments(calls[0], "Attached file:");
});

test("a queued web slash command is expanded and keeps the attachments", async () => {
  const { expandWebSlashCommand } = await jiti.import("@/lib/web-slash-commands");
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const user = userEvent.setup();
  const calls = await renderRunningWithAttachments();
  await user.type(screen.getByRole("textbox"), "/goal ship it");
  await user.keyboard("{Enter}");
  await waitFor(() => assert.equal(calls.length, 1));
  delete window.HTMLElement.prototype.scrollIntoView;
  assert.equal(calls[0].name, "onPromptWithStreamingBehavior");
  assertQueuedWithAttachments(calls[0], expandWebSlashCommand("/goal ship it").prompt);
});

test("a refused follow-up goes back whole to its draft, ahead of what was typed meanwhile", async () => {
  let refuse;
  const calls = await renderRunningWithAttachments({ queued: new Promise((resolve) => { refuse = () => resolve(false); }) });
  fireEvent.click(screen.getByRole("button", { name: /queue/i }));
  await waitFor(() => assert.equal(calls.length, 1));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "typed meanwhile" } });
  await act(async () => { refuse(); });
  await waitFor(() => assert.deepEqual(getDraft(KEY)?.images, [{ data: PNG, mimeType: "image/png" }]));
  assert.equal(getDraft(KEY)?.value, `${calls[0].message}\n\ntyped meanwhile`, "the text, file contents included, comes back too");
  assert.equal(screen.getByRole("textbox").value, `${calls[0].message}\n\ntyped meanwhile`);
});

test("recovered images past the attachment cap all stay in the composer", async () => {
  const { MAX_ATTACHED_IMAGES } = await jiti.import("@/lib/image-attachments");
  const { recoverDraft } = await jiti.import("@/lib/draft-store");
  await renderRunningWithAttachments();
  const recovered = Array.from({ length: MAX_ATTACHED_IMAGES }, () => ({ data: PNG, mimeType: "image/png" }));
  await act(async () => { recoverDraft(KEY, { text: "", images: recovered }); });
  await waitFor(() => assert.equal(getDraft(KEY)?.images.length, MAX_ATTACHED_IMAGES + 1));
  assert.equal(document.querySelectorAll("img").length >= MAX_ATTACHED_IMAGES + 1, true, "every image has a preview to remove");
});

// Keep the real useDictation hook: only browser capture and the STT job API
// are controlled. Polls expose status; only the owner's claim returns text
// and the send intent, matching the server job boundary.
function installPendingDictation() {
  const uploads = [];
  const polls = [];
  const claims = [];
  let done = false;
  class TestMediaRecorder {
    state = "inactive";
    mimeType = "audio/webm";
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["spoken audio"], { type: this.mimeType }) });
      this.onstop?.();
    }
  }
  override(navigator, "mediaDevices", {
    getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
  });
  override(window, "MediaRecorder", TestMediaRecorder);
  override(globalThis, "MediaRecorder", TestMediaRecorder);
  // jsdom has no canvas renderer; waveform drawing is outside this regression.
  override(window.HTMLCanvasElement.prototype, "getContext", () => null);
  const response = (body, status = 200) => ({ ok: true, status, json: async () => body });
  override(globalThis, "fetch", async (url, init) => {
    const target = new URL(url, window.location.href);
    const method = init?.method ?? "GET";
    if (target.pathname === "/api/stt" && method === "GET" && target.searchParams.get("scope") === KEY) {
      return response({ jobs: [] });
    }
    if (target.pathname === "/api/stt" && method === "POST") {
      uploads.push({
        after: init.body.get("after"),
        owner: init.body.get("owner"),
        scope: init.body.get("scope"),
        file: init.body.get("file"),
      });
      return response({ jobId: "edit-pending-job" }, 202);
    }
    if (target.pathname === "/api/stt/edit-pending-job" && method === "GET") {
      const status = done ? "done" : "pending";
      polls.push(status);
      return response({ status });
    }
    if (target.pathname === "/api/stt/edit-pending-job" && method === "DELETE" && target.searchParams.has("claim")) {
      const claim = { token: target.searchParams.get("claim"), owner: target.searchParams.get("owner") };
      claims.push(claim);
      return response({
        status: "done",
        text: "transcribed words",
        after: claim.owner === uploads[0]?.owner ? "send" : undefined,
      });
    }
    throw new Error(`Unexpected dictation request: ${method} ${url}`);
  });
  return { uploads, polls, claims, complete: () => { done = true; } };
}

for (const { label, queueCallbacks } of [
  { label: "idle composer", queueCallbacks: false },
  { label: "queue callbacks available", queueCallbacks: true },
]) {
  test(`an after:send transcript finishing during Edit stays in the draft until explicit send (${label})`, async () => {
    const dictation = installPendingDictation();
    const user = userEvent.setup();
    const { calls, rerender } = await renderWithAttachments({ isStreaming: false, queueCallbacks });
    await user.type(screen.getByRole("textbox"), "keep this draft");
    const beforeTranscript = getDraft(KEY);

    await user.click(screen.getByRole("button", { name: "Start dictation" }));
    await user.click(await screen.findByTitle("Transcribe and send"));
    await waitFor(() => assert.equal(dictation.uploads.length, 1));
    const [upload] = dictation.uploads;
    assert.equal(upload.after, "send", "the real hook uploads the chosen completion action");
    assert.equal(upload.scope, KEY);
    assert.ok(upload.owner);
    assert.equal(upload.file.type, "audio/webm");
    assert.ok(upload.file.size > 0, "audio crosses the recorder/upload boundary");
    await waitFor(() => assert.equal(dictation.polls[0], "pending"), { timeout: 3000 });

    // Edit is not a model run: leave isStreaming false while the job completes.
    rerender({ submissionBlocked: true });
    dictation.complete();
    const finalText = "keep this draft transcribed words";
    const expectedDraft = { ...beforeTranscript, value: finalText };
    await waitFor(() => {
      assert.equal(screen.getByRole("textbox").value, finalText);
      assert.deepEqual(getDraft(KEY), expectedDraft, "text, image and text-file attachments survive");
    }, { timeout: 3000 });
    assert.equal(dictation.claims.length, 1, "delivery comes through the real hook's claim request");
    assert.ok(dictation.claims[0].token);
    assert.equal(dictation.claims[0].owner, upload.owner);
    assert.deepEqual(calls, [], "neither a prompt nor any queue callback may run while Edit is pending");
    assert.equal(screen.getByRole("button", { name: /^send$/i }).disabled, true);

    if (!queueCallbacks) {
      await user.click(screen.getByRole("textbox"));
      await user.keyboard("{Enter}");
      assert.deepEqual(calls, [], "keyboard submit also respects the pending Edit");
      assert.equal(screen.getByRole("textbox").value, finalText);
      assert.deepEqual(getDraft(KEY), expectedDraft);
    }

    rerender({ submissionBlocked: false });
    assert.deepEqual(calls, [], "unblocking must not replay the saved automatic send choice");
    assert.equal(screen.getByRole("button", { name: /^send$/i }).disabled, false);
    await user.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => assert.equal(calls.length, 1));
    assert.equal(calls[0].name, "onSend");
    assertQueuedWithAttachments(calls[0], finalText);
    await waitFor(() => assert.equal(getDraft(KEY), null));
    assert.equal(screen.getByRole("textbox").value, "");
  });
}

test("an image-only send refused by another tab's Edit returns its attachment", async () => {
  const ref = React.createRef();
  const calls = [];
  render(React.createElement(ChatInput, {
    ref, draftKey: KEY, isStreaming: false, onAbort() {},
    onSend: async (message, images) => { calls.push({ message, images }); return { status: "rejected" }; },
  }));
  await act(async () => { ref.current.addFiles([new File([Buffer.from(PNG, "base64")], "dot.png", { type: "image/png" })]); });
  await waitFor(() => assert.equal(getDraft(KEY)?.images.length, 1));
  await userEvent.setup().click(screen.getByRole("button", { name: /^send$/i }));
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0].message, "");
  await waitFor(() => assert.deepEqual(getDraft(KEY)?.images, [{ data: PNG, mimeType: "image/png" }]));
  assert.equal(screen.getByRole("textbox").value, "");
  assert.equal(document.querySelectorAll("img").length, 1, "the restored image is visible, not merely stored");
});

test("a refused ordinary send restores text, file contents and images ahead of newer typing", async () => {
  let refuse;
  const user = userEvent.setup();
  const { calls } = await renderWithAttachments({ isStreaming: false, queueCallbacks: false, queued: new Promise((resolve) => { refuse = () => resolve(false); }) });
  await user.type(screen.getByRole("textbox"), "original question");
  await user.click(screen.getByRole("button", { name: /^send$/i }));
  await waitFor(() => assert.equal(calls.length, 1));
  await user.type(screen.getByRole("textbox"), "typed meanwhile");
  await act(async () => { refuse(); });
  await waitFor(() => assert.deepEqual(getDraft(KEY)?.images, [{ data: PNG, mimeType: "image/png" }]));
  assert.equal(getDraft(KEY).value, `${calls[0].message}\n\ntyped meanwhile`);
  assert.equal(screen.getByRole("textbox").value, getDraft(KEY).value);
  assertQueuedWithAttachments(calls[0], "original question");
});

test("a refused ordinary send recovers only into its originating session draft", async (t) => {
  const otherKey = "ordinary-send-other-session";
  t.after(() => clearDraft(otherKey));
  let refuse;
  const user = userEvent.setup();
  const { calls, rerender } = await renderWithAttachments({ isStreaming: false, queueCallbacks: false, queued: new Promise((resolve) => { refuse = () => resolve(false); }) });
  await user.type(screen.getByRole("textbox"), "original session");
  await user.click(screen.getByRole("button", { name: /^send$/i }));
  await waitFor(() => assert.equal(calls.length, 1));
  rerender({ draftKey: otherKey });
  await user.type(screen.getByRole("textbox"), "other conversation");
  await act(async () => { refuse(); });
  await waitFor(() => assert.deepEqual(getDraft(KEY)?.images, [{ data: PNG, mimeType: "image/png" }]));
  assert.equal(getDraft(KEY).value, calls[0].message);
  assert.equal(screen.getByRole("textbox").value, "other conversation");
  assert.equal(getDraft(otherKey).value, "other conversation");
  assert.deepEqual(getDraft(otherKey).images, []);
});

test("a refused first send follows its promoted conversation rather than the old new-chat draft", async (t) => {
  const promotedKey = "promoted-first-send";
  t.after(() => clearDraft(promotedKey));
  let refuse;
  const submitted = [];
  const { rerender } = await renderWithAttachments({
    isStreaming: false, queueCallbacks: false,
    onSend: async (message) => { submitted.push(message); return new Promise((resolve) => { refuse = () => resolve({ status: "rejected", recoveryKey: promotedKey }); }); },
  });
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox"), "first question");
  await user.click(screen.getByRole("button", { name: /^send$/i }));
  await waitFor(() => assert.equal(submitted.length, 1));
  rerender({ draftKey: promotedKey });
  await act(async () => { refuse(); });
  await waitFor(() => assert.equal(getDraft(promotedKey)?.value, submitted[0]));
  assert.deepEqual(getDraft(promotedKey).images, [{ data: PNG, mimeType: "image/png" }]);
  assert.equal(screen.getByRole("textbox").value, submitted[0]);
  assert.equal(getDraft(KEY), null, "the original new-chat draft must not resurrect this payload later");
});

test("a superseded send result cannot restore a prompt that was already processed", async () => {
  let supersede;
  const submitted = [];
  await renderWithAttachments({
    isStreaming: false, queueCallbacks: false,
    onSend: async (message) => { submitted.push(message); return new Promise((resolve) => { supersede = () => resolve({ status: "superseded" }); }); },
  });
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox"), "already processed");
  await user.click(screen.getByRole("button", { name: /^send$/i }));
  await waitFor(() => assert.equal(submitted.length, 1));
  await user.type(screen.getByRole("textbox"), "next draft");
  await act(async () => { supersede(); });
  assert.equal(screen.getByRole("textbox").value, "next draft");
  assert.equal(getDraft(KEY).value, "next draft");
  assert.deepEqual(getDraft(KEY).images, []);
});
