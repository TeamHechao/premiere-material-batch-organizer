const test = require("node:test");
const assert = require("node:assert/strict");
const Bridge = require("../src/recycle-bridge");

function fixture(options = {}) {
  const files = new Map();
  const directories = new Set(["E:\\", "E:\\bridge", "E:\\project"]);
  const stats = new Map();
  const id = "a".repeat(32), token = "b".repeat(64);
  const prefix = "E:\\bridge\\" + id;
  const fp = { size: 4, mtimeMs: 100, birthtimeMs: 90, dev: "42", ino: "123", sha256: "c".repeat(64) };
  const request = { id, path: "E:\\input\\a.bin", targetPath: "E:\\project\\a.bin", workspaceRoot: "E:\\project", statePath: "E:\\project\\.premiere-material-space.json", sourceFingerprint: fp, targetFingerprint: fp };
  let at = 0, launches = 0;
  const fs = {
    async lstat(path) {
      if (stats.has(path)) return stats.get(path);
      if (!files.has(path) && !directories.has(path)) throw new Error("系统找不到指定的文件");
      return { size: files.has(path) ? files.get(path).length : 0, isFile: () => files.has(path),
        isDirectory: () => directories.has(path), isSymbolicLink: () => false };
    },
    async readFile(path) { return files.get(path); },
    async mkdir(path) { if (files.has(path)) throw new Error("路径已占用"); directories.add(path); },
    async unlink(path) { files.delete(path); },
    async writeFile(path, value, opts) {
      assert.equal(directories.has(require("node:path").win32.dirname(path)), true, "写入前父目录必须存在");
      assert.equal(opts.flag, "wx"); assert.equal(files.has(path), false); files.set(path, value);
    },
  };
  const api = Bridge.create({ fs, bridge: async () => ({ directory: "E:\\bridge", token }), now: () => at,
    wait: async () => { at += 1000; }, launch: async () => { launches++; }, ...options });
  return { api, fs, files, directories, stats, request, prefix, token, launches: () => launches, now: () => at };
}

function ready(f) {
  f.files.set(f.prefix + ".ready.json", JSON.stringify({ id: f.request.id, token: f.token, status: "ready" }));
}
function completed(f) {
  f.files.set(f.prefix + ".result.json", JSON.stringify({ id: f.request.id, token: f.token, path: f.request.path,
    status: "recycled", receiptId: "d".repeat(64) }));
}

test("首次回收先创建专用目录，认证成功后只移除本事务凭据", async () => {
  let issued;
  const f = fixture({ beforeCommit: async job => {
    issued = job.issuedPath;
    await f.fs.writeFile(issued, JSON.stringify({ id: job.jobId, transactionId: "tx-1" }), { flag: "wx" });
    return true;
  }, onProgress: stage => { if (stage === "committed") completed(f); } });
  f.files.set(f.request.statePath, JSON.stringify({ pendingTransaction: { id: "tx-1", recycleRequest: f.request } }));
  const unrelated = f.request.statePath + ".recycle-" + "e".repeat(32) + ".issued";
  f.files.set(unrelated, "unrelated");
  ready(f);
  assert.equal((await f.api.recycle(f.request)).status, "recycled");
  assert.equal(f.files.has(issued), false);
  assert.equal(f.files.get(unrelated), "unrelated");
});

test("回收凭据目录被文件或任一可识别链接占用时不提交且不调用最终确认", async () => {
  for (const kind of ["file", "link", "boolean-link", "mode-link"]) {
    let confirmations = 0;
    const f = fixture({ beforeCommit: () => { confirmations++; return true; } });
    const folder = "E:\\project\\.premiere-material-recycle";
    if (kind === "file") f.files.set(folder, "preserved");
    else f.stats.set(folder, { isDirectory: () => true,
      ...(kind === "mode-link" ? {mode: 0xa000} : {isSymbolicLink: kind === "link" ? () => true : true}) });
    ready(f);
    await assert.rejects(f.api.recycle(f.request));
    assert.equal(confirmations, 0);
    assert.equal(f.files.has(f.prefix + ".commit.json"), false);
  }
});

test("UXP Stats 没有链接检查方法时可提交原生核验，但不能盲删凭据", async () => {
  let issued;
  const f = fixture({ beforeCommit: async job => {
    issued = job.issuedPath;
    await f.fs.writeFile(issued, JSON.stringify({ id: job.jobId, transactionId: "uxp-tx" }), { flag: "wx" });
    return true;
  }, onProgress: stage => { if (stage === "committed") completed(f); } });
  const lstat = f.fs.lstat;
  f.fs.lstat = async path => {
    const stat = await lstat(path);
    delete stat.isSymbolicLink;
    return stat;
  };
  f.files.set(f.request.statePath, JSON.stringify({ pendingTransaction: { id: "uxp-tx", recycleRequest: f.request } }));
  ready(f);
  assert.equal((await f.api.recycle(f.request)).status, "recycled");
  assert.equal(f.files.has(f.prefix + ".commit.json"), true);
  assert.equal(f.files.has(issued), true, "缺少可靠链接检查时保留小型内部凭据");
});

test("持续收到新进度时允许大文件核验超过30秒并正常完成", async () => {
  let elapsed = 0;
  const f = fixture({ now: () => elapsed, wait: async () => {
    elapsed += 1000;
    f.files.set(f.prefix + ".progress.json", JSON.stringify({ checkedBytes: elapsed, totalBytes: 45000 }));
    if (elapsed >= 45000) completed(f);
  } });
  ready(f);
  assert.equal((await f.api.recycle(f.request)).status, "recycled");
  assert.equal(elapsed, 45000);
});

test("最终确认期间取消时仍不发布commit", async () => {
  let cancelled = false;
  const f = fixture({ cancelled: () => cancelled, beforeCommit: async () => { cancelled = true; return true; } });
  ready(f);
  await assert.rejects(f.api.recycle(f.request), { code: "MATERIAL_RECYCLE_CANCELLED" });
  assert.equal(f.files.has(f.prefix + ".commit.json"), false);
  assert.equal(f.files.has(f.prefix + ".cancel"), true);
});

test("提交写入回执丢失按未决处理，不取消不自动重发", async () => {
  const f = fixture();
  const write = f.fs.writeFile;
  f.fs.writeFile = async (file, ...args) => {
    await write(file, ...args);
    if (file.endsWith(".commit.json")) throw new Error("IO completion unknown");
  };
  ready(f);
  await assert.rejects(f.api.recycle(f.request), { code: "MATERIAL_RECYCLE_UNCERTAIN", committed: true });
  assert.equal(f.files.has(f.prefix + ".commit.json"), true);
  assert.equal(f.files.has(f.prefix + ".cancel"), false);
});

test("已提交请求核对时切换工程及时释放等待", async () => {
  const f = fixture({ cancelled: () => true });
  f.files.set(f.prefix + ".commit.json", JSON.stringify({ id: f.request.id, token: f.token }));
  await assert.rejects(f.api.query(f.request), { code: "MATERIAL_RECYCLE_UNCERTAIN", committed: true });
  assert.equal(f.now(), 0);
  assert.equal(f.files.has(f.prefix + ".cancel"), false);
});

test("提交后助手无回执在30秒停滞后释放，不取消也不重新发起回收", async () => {
  let notifications = 0;
  const f = fixture({ onProgress: () => { notifications++; } });
  ready(f);
  await assert.rejects(f.api.recycle(f.request), { code: "MATERIAL_RECYCLE_UNCERTAIN", committed: true });
  assert.ok(f.now() <= 32000, "不能等待六小时");
  assert.equal(f.files.has(f.prefix + ".commit.json"), true);
  assert.equal(f.files.has(f.prefix + ".cancel"), false);
  assert.ok(notifications <= 2, "相同等待状态不反复刷新界面");
  await assert.rejects(f.api.recycle(f.request), { code: "MATERIAL_RECYCLE_UNCERTAIN", committed: true });
  assert.equal(f.launches(), 1);
});

test("提交后切换工程立即结束等待并保留未决请求", async () => {
  const f = fixture({ cancelled: () => f.files.has(f.prefix + ".commit.json") });
  ready(f);
  await assert.rejects(f.api.recycle(f.request), { code: "MATERIAL_RECYCLE_UNCERTAIN", committed: true });
  assert.ok(f.now() <= 1000);
  assert.equal(f.files.has(f.prefix + ".cancel"), false);
});

test("成功回执也不能清理其他事务、异常文件或未确认的旧凭据", async () => {
  for (const kind of ["other-transaction", "link", "oversized", "no-pending"]) {
    const f = fixture();
    const issued = f.request.statePath + ".recycle-" + f.request.id + ".issued";
    f.files.set(issued, JSON.stringify({ id: f.request.id, transactionId: kind === "other-transaction" ? "other" : "tx-1" }));
    f.files.set(f.request.statePath, JSON.stringify(kind === "no-pending" ? {} : { pendingTransaction: { id: "tx-1", recycleRequest: f.request } }));
    if (kind === "link" || kind === "oversized") f.stats.set(issued, {
      isFile: () => true, isSymbolicLink: () => kind === "link", size: kind === "oversized" ? 999999 : 100,
    });
    completed(f);
    assert.equal((await f.api.recycle(f.request)).status, "recycled");
    assert.equal(f.files.has(issued), true, kind);
  }
});

test("旧格式当前事务凭据仍可在认证成功后清理", async () => {
  const f = fixture();
  const issued = f.request.statePath + ".recycle-" + f.request.id + ".issued";
  f.files.set(issued, JSON.stringify({ id: f.request.id, transactionId: "tx-old" }));
  f.files.set(f.request.statePath, JSON.stringify({ pendingTransaction: { id: "tx-old", recycleRequest: f.request } }));
  completed(f);
  assert.equal((await f.api.recycle(f.request)).status, "recycled");
  assert.equal(f.files.has(issued), false);
});

test("认证失败回执保留占用和权限错误码，未知回收仍不可重试", async () => {
  for (const [win32Error, failureKind] of [[32, "busy"], [33, "busy"], [5, "permission"]]) {
    const f = fixture();
    f.files.set(f.prefix + ".result.json", JSON.stringify({ id: f.request.id, token: f.token, path: f.request.path,
      status: "failed", win32Error, failureKind, message: "原件保留" }));
    await assert.rejects(f.api.recycle(f.request), { code: "MATERIAL_RECYCLE_FAILED", win32Error, failureKind, committed: false });
    assert.equal(f.launches(), 0);
  }
  const f = fixture();
  f.files.set(f.prefix + ".result.json", JSON.stringify({ id: f.request.id, token: f.token, path: f.request.path,
    status: "uncertain", win32Error: 32, failureKind: "busy" }));
  await assert.rejects(f.api.recycle(f.request), { code: "MATERIAL_RECYCLE_UNCERTAIN", committed: true });
});

test("助手预检只交换检查记录，不登记素材回收", async () => {
  const f = fixture({ launch: async uri => {
    assert.match(uri, /:\/\/probe\/[0-9a-f]{32}$/);
    const id = uri.slice(-32), prefix = "E:\\bridge\\" + id;
    const request = JSON.parse(f.files.get(prefix + ".probe-request.json"));
    assert.equal(request.path, undefined);
    f.files.set(prefix + ".probe-result.json", JSON.stringify({ id, token: f.token, version: 1, status: "available" }));
  } });
  assert.deepEqual(await f.api.checkAvailability(), { status: "available" });
  assert.equal([...f.files.keys()].some(path => path.endsWith(".commit.json")), false);
});

test("助手预检无响应时明确失败且不提交回收", async () => {
  const f = fixture();
  await assert.rejects(f.api.checkAvailability(), { code: "MATERIAL_RECYCLE_NOT_COMMITTED" });
  assert.equal(f.files.size, 1);
});

test("目录打开只发送认证目录请求，不提交素材回收", async () => {
  const f = fixture({ launch: async uri => {
    assert.match(uri, /:\/\/reveal\/[0-9a-f]{32}$/);
    const id = uri.slice(-32), prefix = "E:\\bridge\\" + id;
    const request = JSON.parse(f.files.get(prefix + ".reveal-request.json"));
    assert.equal(request.directory, "E:\\素材目录");
    f.files.set(prefix + ".reveal-result.json", JSON.stringify({ id, token: f.token, status: "opened" }));
  } });
  await f.api.revealDirectory("E:\\素材目录");
  assert.equal([...f.files.keys()].some(p => p.endsWith(".commit.json")), false);
  await assert.rejects(f.api.revealDirectory("E:\\目录\\..\\其他"), /路径无效/);
});

test("UXP 无错误码的缺失文件可等待，助手未启动在 30 秒后保留源文件", async () => {
  const f = fixture();
  await assert.rejects(f.api.recycle(f.request), { code: "MATERIAL_RECYCLE_NOT_COMMITTED" });
  assert.equal(f.launches(), 1);
  assert.equal(f.files.has(f.prefix + ".cancel"), true);
  assert.equal(f.files.has(f.prefix + ".commit.json"), false);
});

test("协议启动失败也留下取消凭据，不提交回收", async () => {
  const f = fixture({ launch: async () => { throw new Error("启动失败"); } });
  await assert.rejects(f.api.recycle(f.request), /启动失败/);
  assert.equal(f.files.has(f.prefix + ".cancel"), true);
  assert.equal(f.files.has(f.prefix + ".commit.json"), false);
});

test("本地助手缺失时明确失败，不调用宿主授权也不提交回收", async () => {
  let calls = 0;
  const f = fixture({ launch: undefined, uxp: { shell: { openExternal: async () => { calls++; throw new Error("launch denied"); } } } });
  await assert.rejects(f.api.recycle(f.request), { code: "MATERIAL_RECYCLE_LAUNCH_FAILED" });
  assert.equal(calls, 0);
  assert.equal(f.files.has(f.prefix + ".cancel"), true);
  assert.equal(f.files.has(f.prefix + ".commit.json"), false);
});

test("宿主拒绝所有外部启动时，文件服务仍能响应预检", async () => {
  let hostCalls = 0;
  const f = fixture({ launch: undefined, uxp: { shell: { openExternal: async () => { hostCalls++; throw new Error("denied"); } } }, wait: async () => {
    for (const [file, json] of f.files) {
      if (!file.endsWith(".dispatch.json")) continue;
      const request = JSON.parse(json);
      f.files.set(file.replace(".dispatch.json", ".dispatch-result.json"), JSON.stringify({ ...request, status: "dispatched" }));
      f.files.set("E:\\bridge\\" + request.id + ".probe-result.json", JSON.stringify({ id: request.id, token: f.token, version: 1, status: "available" }));
    }
  } });
  f.files.set("E:\\bridge\\service.current.json", JSON.stringify({ session: "c".repeat(32), token: f.token, version: 1 }));
  assert.deepEqual(await f.api.checkAvailability(), { status: "available" });
  assert.equal(hostCalls, 0);
  assert.equal(f.files.has(f.prefix + ".commit.json"), false);
});

test("缓存的伪造成功回执不能绕过身份检查", async () => {
  const f = fixture();
  f.files.set(f.prefix + ".result.json", JSON.stringify({ id: f.request.id, token: "wrong", path: f.request.path, status: "recycled", receiptId: "d".repeat(64) }));
  await assert.rejects(f.api.recycle(f.request), { code: "MATERIAL_RECYCLE_PROTOCOL" });
  assert.equal(f.launches(), 0);
});

test("已核实的缓存成功回执只查询，不重复启动回收", async () => {
  const f = fixture();
  f.files.set(f.prefix + ".result.json", JSON.stringify({ id: f.request.id, token: f.token, path: f.request.path, status: "recycled", receiptId: "d".repeat(64) }));
  assert.equal((await f.api.recycle(f.request)).status, "recycled");
  assert.equal(f.launches(), 0);
});

test("已有未提交请求不覆盖，不重复启动助手", async () => {
  const f = fixture();
  f.files.set(f.prefix + ".request.json", "{}");
  await assert.rejects(f.api.recycle(f.request), { code: "MATERIAL_RECYCLE_REQUEST_EXISTS" });
  assert.equal(f.launches(), 0);
});

test("取消凭据只允许未提交的旧请求重试，提交凭据优先", async () => {
  const f = fixture();
  const payload = JSON.stringify({ ...f.request, token: f.token });
  f.files.set(f.prefix + ".request.json", payload);
  f.files.set(f.prefix + ".cancel", "{}");
  assert.equal((await f.api.query(f.request)).state, "cancelled");
  f.files.set(f.prefix + ".commit.json", payload);
  await assert.rejects(f.api.query(f.request), { code: "MATERIAL_RECYCLE_UNCERTAIN", committed: true });
});

test("未知回收结果只唤起核对协议，不重复执行 job", async () => {
  const launches = [];
  const f = fixture({ launch: async uri => {
    launches.push(uri);
    f.files.set(f.prefix + ".reconciled.json", JSON.stringify({ id: f.request.id, token: f.token, path: f.request.path,
      status: "failed", message: "原素材已恢复原位" }));
  } });
  f.files.set(f.prefix + ".commit.json", JSON.stringify({ id: f.request.id, token: f.token }));
  assert.equal((await f.api.query(f.request)).value.status, "failed");
  assert.deepEqual(launches, [Bridge.SCHEME + "://query/" + f.request.id]);
});

test("恢复回执源路径不匹配时拒绝采用", async () => {
  const f = fixture({ launch: async () => {
    f.files.set(f.prefix + ".reconciled.json", JSON.stringify({ id: f.request.id, token: f.token, path: "E:\\other.bin", status: "failed" }));
  } });
  f.files.set(f.prefix + ".commit.json", JSON.stringify({ id: f.request.id, token: f.token }));
  await assert.rejects(f.api.query(f.request), { code: "MATERIAL_RECYCLE_PROTOCOL" });
});

test("缺少卷号或文件标识时不登记也不启动回收", async () => {
  for (const field of ["dev", "ino"]) {
    const f = fixture();
    f.request.sourceFingerprint = { ...f.request.sourceFingerprint, [field]: "" };
    await assert.rejects(f.api.recycle(f.request), /完整文件指纹/);
    assert.equal(f.files.size, 0);
    assert.equal(f.launches(), 0);
  }
});

test("旧的不确定核对结果必须等待新回执，不能立即复用", async () => {
  let waits = 0;
  const f = fixture({ wait: async () => {
    waits++;
    f.files.set(f.prefix + ".reconciled.json", JSON.stringify({ ...old, status: "failed", checkedAt: 2 }));
  } });
  const old = { id: f.request.id, token: f.token, path: f.request.path, status: "uncertain", checkedAt: 1 };
  f.files.set(f.prefix + ".reconciled.json", JSON.stringify(old));
  assert.equal((await f.api.query(f.request)).value.status, "failed");
  assert.equal(waits, 1);
  assert.equal(f.launches(), 1);
});
