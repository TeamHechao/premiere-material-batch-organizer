const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../src/core");
const State = require("../src/state");

const at = new Date("2026-10-02T10:00:00Z");
const projectPath = "E:\\Project\\edit.prproj";
const projectIdentity = "path:e:\\project\\edit.prproj|guid:174de708-8299-412c-9e1b-27ed8eb982f1";
const legacyError = "目标已就绪，原文件待回收：轨道素材类型无法核对，原素材保留";

function record(overrides = {}) {
  return { id: "tx-held", sourcePath: "C:\\Downloads\\sound.wav",
    targetPath: "E:\\Project\\素材\\batch\\sound.wav", targetRelativePath: "素材\\batch\\sound.wav",
    projectPath, projectIdentity, deleteSource: true, resumeAutomatic: true,
    status: "cleanup-pending", itemCount: 1, itemIds: ["clip-1"],
    sourceFingerprint: { size: 100, mtimeMs: 1000, ctimeMs: 1000, birthtimeMs: 900, dev: "1", ino: "100" },
    targetFingerprint: { size: 100, mtimeMs: 1000, ctimeMs: 1000, birthtimeMs: 900, dev: "2", ino: "200" },
    error: legacyError, backgroundTask: { version: 1, kind: "held", attempts: 2,
      nextAttemptAt: new Date(0).toISOString(), message: legacyError }, ...overrides };
}

function stateFor(items) {
  const state = State.createState("E:\\Project", at);
  state.initialized = true;
  state.deferredTransactions = items;
  return state;
}

test("只把已知旧轨道类型误拦记录接回核验队列，保留原始错误和选择", () => {
  const before = stateFor([record()]);
  assert.equal(State.isTimelineCleanupRetryCandidate(before.deferredTransactions[0]), true);
  const next = State.requeueTimelineCleanup(before, "tx-held", at);
  const queued = next.deferredTransactions[0];
  assert.equal(queued.backgroundTask.kind, "cleanup");
  assert.equal(queued.backgroundTask.nextAttemptAt, at.toISOString());
  assert.equal(queued.backgroundTask.attempts, 2);
  assert.equal(queued.timelineCleanupRetry.version, 1);
  assert.equal(queued.timelineCleanupRetry.previousError, legacyError);
  assert.equal(queued.deleteSource, true);
  assert.deepEqual(queued.sourceFingerprint, before.deferredTransactions[0].sourceFingerprint);
  assert.equal(State.nextBackgroundCleanup(next, projectPath, projectIdentity, at).id, "tx-held");
  assert.equal(before.deferredTransactions[0].backgroundTask.kind, "held");
});

test("升级重启后仅重试一次，不把同一个未知轨道项变成无限重试", () => {
  let state = State.requeueTimelineCleanup(stateFor([record()]), "tx-held", at);
  state.deferredTransactions[0].backgroundTask.kind = "held";
  state = State.hydrateState(state, "E:\\Project", at);
  assert.equal(State.isTimelineCleanupRetryCandidate(state.deferredTransactions[0]), false);
  assert.throws(() => State.requeueTimelineCleanup(state, "tx-held", at), /不能自动接续/);
});

test("接续预检未通过保持暂缓且记住原因，重启不反复尝试", () => {
  const before = stateFor([record()]);
  const next = State.holdTimelineCleanupRetry(before, "tx-held", "新位置文件不存在，原文件保留", at);
  const held = State.hydrateState(next, "E:\\Project", at).deferredTransactions[0];
  assert.equal(held.backgroundTask.kind, "held");
  assert.equal(held.timelineCleanupRetry.previousError, legacyError);
  assert.match(held.backgroundTask.message, /不存在/);
  assert.equal(State.isTimelineCleanupRetryCandidate(held), false);
  assert.equal(before.deferredTransactions[0].error, legacyError);
});

test("保留原件、手动暂缓、其他错误和回收结果不明的记录不自动重试", () => {
  const rejected = [
    { deleteSource: false }, { deleteSource: undefined }, { resumeAutomatic: false },
    { status: "failed" }, { backgroundTask: undefined },
    { error: "目标文件身份不一致" }, { error: "无法读取素材路径" },
    { recycleRequest: { id: "request" } }, { recycleReceipt: { status: "recycled" } },
    { recycleAttempts: [{ request: { id: "old-request" } }] },
    { itemIds: [] }, { itemCount: 2 }, { itemIds: ["same", "same"], itemCount: 2 },
    { targetRelativePath: "..\\outside.wav" }, { sourcePath: projectPath },
    { timelineCleanupRetry: { version: 2 } },
  ];
  for (const overrides of rejected) {
    const item = record(overrides);
    assert.equal(State.isTimelineCleanupRetryCandidate(item), false, JSON.stringify(overrides));
  }
  const permission = record({ error: "原文件没有访问权限" });
  const state = stateFor([permission]);
  assert.throws(() => State.requeueTimelineCleanup(state, permission.id, at), /不能自动接续/);
});

test("有未决事务或工程待保存时不能重新排入旧记录", () => {
  for (const field of ["pendingTransaction", "pendingProjectSave"]) {
    const state = stateFor([record()]);
    state[field] = { id: "another" };
    assert.throws(() => State.requeueTimelineCleanup(state, "tx-held", at), /当前操作尚未完成/);
  }
});

test("工程目录变更只接受已核验的所属工程和受限目标路径，保留旧归属", () => {
  const before = stateFor([record()]);
  const newPath = "I:\\接手工程\\edit.prproj";
  const owner = { projectPath: newPath,
    projectIdentity: "path:i:\\接手工程\\edit.prproj|guid:174de708-8299-412c-9e1b-27ed8eb982f1",
    targetPath: "I:\\接手工程\\素材\\batch\\sound.wav" };
  const next = State.requeueTimelineCleanup(before, "tx-held", at, owner);
  assert.equal(next.deferredTransactions[0].projectPath, newPath);
  assert.equal(next.deferredTransactions[0].targetPath, owner.targetPath);
  assert.equal(next.deferredTransactions[0].timelineCleanupRetry.previousProjectPath, projectPath);
  assert.equal(State.nextBackgroundCleanup(next, projectPath, projectIdentity, at), null);
  assert.equal(State.nextBackgroundCleanup(next, newPath, owner.projectIdentity, at).id, "tx-held");
  for (const invalid of [{ ...owner, targetPath: "I:\\outside.wav" },
    { ...owner, projectPath: "relative.prproj" }, { ...owner, projectIdentity: "" }]) {
    assert.throws(() => State.requeueTimelineCleanup(before, "tx-held", at, invalid), /归属|目标/);
  }
  assert.equal(Core.samePath(next.deferredTransactions[0].sourcePath, record().sourcePath), true);
});
