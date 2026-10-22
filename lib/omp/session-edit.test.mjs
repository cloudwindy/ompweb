import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import registerSessionEdit, { SESSION_EDIT_COMMAND, SESSION_EDIT_RESPONSE_PREFIX } from "./session-edit-extension.mjs";

const jiti = createJiti(import.meta.url);
const { editSessionHistory, SESSION_EDIT_EXTENSION_PATH } = await jiti.import("./session-edit.ts");
const { RpcProcess, RpcCommandTimeoutError } = await jiti.import("./rpc-process.ts");

const immediate = () => new Promise((resolve) => setImmediate(resolve));
const editReply = (result) => ({
  type: "extension_ui_request", method: "notify", message: SESSION_EDIT_RESPONSE_PREFIX + JSON.stringify(result),
});

function editTransport() {
  const listeners = new Set();
  const commands = [];
  const requests = [];
  const transport = {
    commands,
    requests,
    catalog: { commands: [{ name: SESSION_EDIT_COMMAND, source: "extension" }] },
    onPrompt: () => ({ agentInvoked: false }),
    get listenerCount() { return listeners.size; },
    onFrame(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(frame) { for (const listener of listeners) listener(frame); },
    async sendCommand(command, timeoutMs) {
      commands.push(command);
      assert.ok(timeoutMs > 0, "both catalog lookup and prompt acknowledgement must be bounded");
      if (command.type === "get_available_commands") return transport.catalog;
      assert.equal(command.type, "prompt");
      assert.ok(command.message.startsWith(`/${SESSION_EDIT_COMMAND} `));
      const request = JSON.parse(command.message.slice(SESSION_EDIT_COMMAND.length + 2));
      requests.push(request);
      return transport.onPrompt(request);
    },
  };
  return transport;
}

for (const commands of [[], [{ name: SESSION_EDIT_COMMAND, source: "builtin" }], [{ name: "other", source: "extension" }]]) {
  test(`an unavailable edit extension never falls through to a model prompt (${JSON.stringify(commands)})`, async () => {
    const proc = editTransport();
    proc.catalog = { commands };
    await assert.rejects(editSessionHistory(proc, "u2", "same-session"), /edit extension is unavailable/);
    assert.deepEqual(proc.commands.map((command) => command.type), ["get_available_commands"]);
    assert.equal(proc.listenerCount, 0);
  });
}

test("edit replies are correlated across interleaved requests and listeners leave after completion", async () => {
  const proc = editTransport();
  let firstSettled = false;
  const first = editSessionHistory(proc, "u2", "same-session");
  const second = editSessionHistory(proc, "u3", "same-session");
  void first.then(() => { firstSettled = true; });
  await immediate();
  const [one, two] = proc.requests;
  assert.notEqual(one.requestId, two.requestId);
  assert.equal(proc.listenerCount, 2);
  proc.emit({ type: "extension_ui_request", method: "notify", message: `${SESSION_EDIT_RESPONSE_PREFIX}{` });
  proc.emit(editReply({ requestId: "unrelated", sessionId: "same-session", cancelled: false, leafId: "wrong" }));
  proc.emit(editReply({ requestId: two.requestId, sessionId: "same-session", cancelled: false, leafId: "marker-two" }));
  assert.deepEqual(await second, { sessionId: "same-session", cancelled: false, leafId: "marker-two" });
  assert.equal(firstSettled, false);
  assert.equal(proc.listenerCount, 1);
  proc.emit(editReply({ requestId: one.requestId, sessionId: "same-session", cancelled: true, leafId: "original-leaf" }));
  assert.deepEqual(await first, { sessionId: "same-session", cancelled: true, leafId: "original-leaf" });
  assert.equal(proc.listenerCount, 0);
  proc.emit(editReply({ requestId: two.requestId, error: "late duplicate" }));
});

test("an explicit extension failure rejects even when native prompt acknowledgement reports success", async () => {
  const proc = editTransport();
  proc.onPrompt = ({ requestId }) => {
    proc.emit(editReply({ requestId, error: "The edit target must be a user message" }));
    return { agentInvoked: false };
  };
  await assert.rejects(editSessionHistory(proc, "assistant-entry", "same-session"), /target must be a user message/);
  assert.equal(proc.listenerCount, 0);
});

for (const invalid of [
  { sessionId: "forked-session", cancelled: false, leafId: "marker" },
  { sessionId: "same-session", cancelled: "false", leafId: "marker" },
  { sessionId: "same-session", cancelled: false, leafId: 123 },
]) {
  test(`invalid native edit outcomes cannot look successful (${JSON.stringify(invalid)})`, async () => {
    const proc = editTransport();
    proc.onPrompt = ({ requestId }) => {
      proc.emit(editReply({ requestId, ...invalid }));
      return { agentInvoked: false };
    };
    await assert.rejects(editSessionHistory(proc, "u2", "same-session"), /invalid history edit result/);
    assert.equal(proc.listenerCount, 0);
  });
}

test("a prompt transport failure removes its reply listener and does not poison the next edit", async () => {
  const proc = editTransport();
  proc.onPrompt = () => { throw new Error("pipe closed"); };
  await assert.rejects(editSessionHistory(proc, "u2", "same-session"), /pipe closed/);
  assert.equal(proc.listenerCount, 0);
  proc.onPrompt = ({ requestId }) => {
    proc.emit(editReply({ requestId, sessionId: "same-session", cancelled: false, leafId: null }));
    return { agentInvoked: false };
  };
  assert.deepEqual(await editSessionHistory(proc, "u1", "same-session"), {
    sessionId: "same-session", cancelled: false, leafId: null,
  });
  assert.equal(proc.listenerCount, 0);
});

test("a timed-out reply is cleaned up and a late outcome cannot settle the next edit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const proc = editTransport();
  const expired = editSessionHistory(proc, "u2", "same-session");
  const rejection = assert.rejects(expired, (error) => {
    assert.ok(error instanceof RpcCommandTimeoutError);
    assert.equal(error.command, "edit_message");
    return true;
  });
  await immediate();
  const oldRequest = proc.requests[0];
  t.mock.timers.tick(15_000);
  await rejection;
  assert.equal(proc.listenerCount, 0);

  let settled = false;
  const current = editSessionHistory(proc, "u3", "same-session");
  void current.then(() => { settled = true; });
  await immediate();
  proc.emit(editReply({ requestId: oldRequest.requestId, sessionId: "same-session", cancelled: false, leafId: "old-marker" }));
  await immediate();
  assert.equal(settled, false);
  proc.emit(editReply({ requestId: proc.requests[1].requestId, sessionId: "same-session", cancelled: false, leafId: "current-marker" }));
  assert.equal((await current).leafId, "current-marker");
  assert.equal(proc.listenerCount, 0);
  t.mock.timers.tick(15_000);
});

function extensionContext({ idle = true, entry = { id: "u2", type: "message", message: { role: "user" } }, navigate } = {}) {
  let command;
  const replies = [];
  const appended = [];
  let navigations = 0;
  registerSessionEdit({
    registerCommand(name, definition) { assert.equal(name, SESSION_EDIT_COMMAND); command = definition; },
    appendEntry(...args) { appended.push(args); },
  });
  const ctx = {
    isIdle: () => idle,
    sessionManager: {
      getEntry: () => entry,
      getSessionId: () => "same-session",
      getLeafId: () => "original-leaf",
    },
    navigateTree: async (...args) => { navigations += 1; return navigate(...args); },
    ui: { notify(message) { replies.push(JSON.parse(message.slice(SESSION_EDIT_RESPONSE_PREFIX.length))); } },
  };
  return {
    run: () => command.handler(JSON.stringify({ requestId: "correlated-request", entryId: "u2" }), ctx),
    replies, appended, ctx, get navigations() { return navigations; },
  };
}

for (const entry of [undefined, { id: "a1", type: "message", message: { role: "assistant" } }, { id: "custom", type: "custom" }]) {
  test(`the bridge rejects non-user edit targets without navigating or appending (${JSON.stringify(entry)})`, async () => {
    const native = extensionContext({ entry: entry ?? null });
    await native.run();
    assert.deepEqual(native.replies, [{ requestId: "correlated-request", error: "The edit target must be a user message" }]);
    assert.equal(native.navigations, 0);
    assert.deepEqual(native.appended, []);
  });
}

test("the bridge refuses a busy native session before navigation", async () => {
  const native = extensionContext({ idle: false });
  await native.run();
  assert.deepEqual(native.replies, [{ requestId: "correlated-request", error: "Cannot edit while the agent is running" }]);
  assert.equal(native.navigations, 0);
  assert.deepEqual(native.appended, []);
});

test("cancelled navigation explicitly replies but never persists a history marker", async () => {
  const native = extensionContext({ navigate: async () => ({ cancelled: true }) });
  await native.run();
  assert.deepEqual(native.replies, [{ requestId: "correlated-request", sessionId: "same-session", cancelled: true, leafId: "original-leaf" }]);
  assert.equal(native.navigations, 1);
  assert.deepEqual(native.appended, []);
});

test("navigation errors produce a correlated error reply rather than native's swallowed prompt success", async () => {
  const native = extensionContext({ navigate: async () => { throw new Error("navigation hook rejected"); } });
  await native.run();
  assert.deepEqual(native.replies, [{ requestId: "correlated-request", error: "navigation hook rejected" }]);
  assert.deepEqual(native.appended, []);
});

test("a navigation hook cannot silently switch sessions before the durable edit marker", async () => {
  let changed = false;
  const native = extensionContext({ navigate: async () => { changed = true; return { cancelled: false }; } });
  native.ctx.sessionManager.getSessionId = () => changed ? "unexpected-session" : "same-session";
  await native.run();
  assert.deepEqual(native.replies, [{ requestId: "correlated-request", error: "The session changed while editing history" }]);
  assert.deepEqual(native.appended, []);
});

test("an unacknowledged edit prompt is bounded and removes its correlated listener", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const proc = editTransport();
  proc.onPrompt = () => new Promise((_, reject) => {
    setTimeout(() => reject(new RpcCommandTimeoutError("prompt", 15_000)), 15_000);
  });
  const pending = editSessionHistory(proc, "u2", "same-session");
  const rejection = assert.rejects(pending, (error) => {
    assert.ok(error instanceof RpcCommandTimeoutError);
    assert.equal(error.command, "prompt");
    return true;
  });
  await immediate();
  t.mock.timers.tick(15_000);
  await rejection;
  assert.equal(proc.listenerCount, 0);
});

// Opt in explicitly: the ordinary suite never launches a user's installed OMP.
// Only the internal slash command is prompted; no model, summary, title, or
// credential-dependent operation is invoked.
test("native edit changes effective context in the same file and survives reopening", {
  skip: process.env.OMP_WEB_TEST_NATIVE_EDIT !== "1",
  timeout: 90_000,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-native-edit-"));
  const processes = [];
  t.after(async () => {
    await Promise.all(processes.map((proc) => proc.dispose()));
    rmSync(root, { recursive: true, force: true });
  });
  const agentDir = join(root, "agent");
  const fixtureProvider = "omp-web-edit-fixture";
  const fixtureModel = "history-edit-fixture";
  const fixtureApi = "openai-completions";
  // Restore only this offline model, never a user's credentials or provider catalog.
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.yml"), `providers:
  ${fixtureProvider}:
    baseUrl: http://127.0.0.1:1/v1
    apiKey: native-edit-fixture-inert-key
    api: ${fixtureApi}
    models:
      - id: ${fixtureModel}
        contextWindow: 8192
        maxTokens: 1024
`);
  const sessionId = randomUUID();
  const sessionFile = join(root, "edit-fixture.jsonl");
  const timestamp = "2026-01-01T00:00:00.000Z";
  const message = (id, parentId, role, text) => ({
    type: "message", id, parentId, timestamp,
    message: role === "user"
      ? { role, content: text, timestamp: 1 }
      : {
          role, content: [{ type: "text", text }], timestamp: 1,
          api: fixtureApi, provider: fixtureProvider, model: fixtureModel, stopReason: "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        },
  });
  const original = [
    { type: "session", version: 3, id: sessionId, cwd: root, timestamp },
    message("u1", null, "user", "retained question"),
    message("a1", "u1", "assistant", "retained answer"),
    message("u2", "a1", "user", "edit this question"),
    message("a2", "u2", "assistant", "discarded answer"),
  ];
  writeFileSync(sessionFile, original.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const { buildSessionContext } = await jiti.import("../session-reader.ts");
  const { loadSessionFile } = await jiti.import("./session-files.ts");
  const open = async () => {
    const proc = new RpcProcess({
      cwd: root,
      env: { PI_CODING_AGENT_DIR: agentDir, OMP_PROFILE: "", PI_PROFILE: "" },
      extraArgs: ["--resume", sessionFile, "--no-tools", "--no-rules", "--no-skills", "--no-extensions", "--no-title", "--extension", SESSION_EDIT_EXTENSION_PATH],
    });
    processes.push(proc);
    const ready = await proc.waitReady();
    await proc.negotiateProtocol(ready);
    return proc;
  };
  const textOf = (messages) => messages.map((item) => typeof item.content === "string"
    ? item.content : item.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
  const proc = await open();
  const before = await proc.sendCommand({ type: "get_state" }, 5_000);
  assert.equal(before.sessionId, sessionId);
  assert.equal(before.sessionFile, sessionFile);
  const activeBefore = await proc.sendCommand({ type: "get_messages" }, 5_000);
  assert.deepEqual(textOf(activeBefore.messages), ["retained question", "retained answer", "edit this question", "discarded answer"]);
  const beforeInvalid = readFileSync(sessionFile, "utf8");
  await assert.rejects(editSessionHistory(proc, "a1", sessionId), /target must be a user message/);
  assert.equal(readFileSync(sessionFile, "utf8"), beforeInvalid, "invalid targets do not persist any entry");

  const edited = await editSessionHistory(proc, "u2", sessionId);
  assert.equal(edited.cancelled, false);
  assert.equal(edited.sessionId, sessionId);
  assert.ok(edited.leafId);
  const after = await proc.sendCommand({ type: "get_state" }, 5_000);
  assert.equal(after.sessionId, sessionId);
  assert.equal(after.sessionFile, sessionFile);
  assert.deepEqual(textOf((await proc.sendCommand({ type: "get_messages" }, 5_000)).messages), ["retained question", "retained answer"]);
  const entries = loadSessionFile(sessionFile).entries;
  for (const id of ["u1", "a1", "u2", "a2"]) assert.ok(entries.some((entry) => entry.id === id), "the original branch is retained");
  const marker = entries.find((entry) => entry.id === edited.leafId);
  assert.equal(marker.type, "custom");
  assert.equal(marker.customType, "omp-web-history-navigation");
  assert.equal(marker.parentId, "a1");
  assert.deepEqual(marker.data, { entryId: "u2" });
  assert.deepEqual(buildSessionContext(entries).entryIds, ["u1", "a1"]);
  assert.deepEqual(buildSessionContext(entries, "a2").entryIds, ["u1", "a1", "u2", "a2"]);
  await proc.dispose();

  const resumed = await open();
  const reopened = await resumed.sendCommand({ type: "get_state" }, 5_000);
  assert.equal(reopened.sessionId, sessionId);
  assert.equal(reopened.sessionFile, sessionFile);
  assert.deepEqual(textOf((await resumed.sendCommand({ type: "get_messages" }, 5_000)).messages), ["retained question", "retained answer"]);
  assert.deepEqual(buildSessionContext(loadSessionFile(sessionFile).entries).entryIds, ["u1", "a1"]);
  await resumed.dispose();
});
