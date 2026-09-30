const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const P = require("../src/preferences");
const W = require("../src/workspace-session");
const Storage = require("../src/storage");
const FileService = require("../src/file-service");

async function fixture(t) {
  const parent = path.join(__dirname, "..", "work", "preferences-tests");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "run-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "preferences.json");
  const values = new Map();
  const cache = { getItem: k => values.get(k) || null, setItem: (k,v) => values.set(k,v) };
  const store = (selectedCache = cache) => P.createStore({ fs, storage: Storage, cache: selectedCache, resolvePath: async () => file });
  return { root, file, values, cache, store };
}
const library = { libraryId: "post-kit", label: "后期包", rootPath: "I:/后期包" };

test("本机名单从旧路径迁移到磁盘，缓存清空后仍能重启读取", async t => {
  const f = await fixture(t);
  const migrated = await f.store().load({ protectedMappings: [library] });
  assert.equal(migrated.confirmed, true);
  f.values.clear();
  const restarted = await f.store().load({});
  assert.deepEqual(restarted.mappings, [library]);
  assert.deepEqual(P.libraries(restarted, []), [{ libraryId: library.libraryId, label: library.label }]);
});

test("明确空名单也保存到磁盘，不会在另一个工程再问", async t => {
  const f = await fixture(t), store = f.store();
  await store.load({});
  await store.save({ ...P.empty(), confirmed: true });
  f.values.clear();
  assert.equal((await f.store().load({})).confirmed, true);
});

test("权威磁盘名单不受缓存读取或写入失败影响", async t => {
  const f = await fixture(t);
  await f.store().load({ protectedMappings: [library] });
  const broken = { getItem() { throw Error("cache unavailable"); }, setItem() { throw Error("cache full"); } };
  const store = f.store(broken);
  const value = await store.load({});
  await store.save(P.withoutMapping(value, library.libraryId));
  assert.deepEqual((await f.store().load({})).removedIds, [library.libraryId]);
});

test("两个面板并发保存不能覆盖较新的名单", async t => {
  const f = await fixture(t), first = f.store(), second = f.store();
  const a = await first.load({}), b = await second.load({});
  await first.save(P.withMapping(a, library));
  await assert.rejects(second.save({ ...b, confirmed: true }), { code: "MATERIAL_BATCH_STORAGE_CONFLICT" });
  assert.equal((await f.store().load({})).mappings.length, 1);
});

test("名单损坏且无可用备份时不使用旧缓存或空名单覆盖", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, "broken");
  f.cache.setItem(P.CACHE_KEY, JSON.stringify(P.empty()));
  await assert.rejects(f.store().load({}));
  assert.equal(await fs.readFile(f.file, "utf8"), "broken");
});

test("较新版本名单不会回退到旧备份", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, JSON.stringify({ ...P.empty(), schemaVersion: 99 }));
  await fs.writeFile(f.file + ".bak", JSON.stringify(P.empty()));
  await assert.rejects(f.store().load({}), /较新版本/);
});

test("移除项不从旧工程或旧缓存复活，其他电脑的同名库不盲目匹配", () => {
  const old = P.withMapping(P.empty(), library);
  const removed = P.withoutMapping(old, library.libraryId);
  assert.deepEqual(P.libraries(removed, [library]), []);
  assert.deepEqual(P.mappings(removed, [library]), []);
  const portable = { libraryId: "other-computer-id", label: "后期包" };
  assert.equal(P.libraries(old, [portable]).length, 2);
  assert.equal(P.mappings(old).some(m => m.libraryId === portable.libraryId), false);
});

test("已有普通素材目录只读取，不创建、不归并、不改名", async t => {
  const f = await fixture(t);
  const media = path.join(f.root, "素材");
  await fs.mkdir(media);
  await fs.writeFile(path.join(media, "原始素材.txt"), "existing");
  const adapted = FileService.createHostFileSystem(fs, async () => { throw Error("no identity read needed"); });
  assert.deepEqual(await W.inspectExistingMedia(adapted, f.root), { existingMedia: true });
  assert.equal(await fs.readFile(path.join(media, "原始素材.txt"), "utf8"), "existing");
  assert.deepEqual(await fs.readdir(media), ["原始素材.txt"]);
});

test("确有旧插件凭据且主记录丢失仍保留现场", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, ".premiere-material-space.json.tmp-proof"), "evidence");
  await assert.rejects(W.inspectExistingMedia(fs, f.root), { code: "MATERIAL_BATCH_STATE_LOST" });
  assert.equal(await fs.readFile(path.join(f.root, ".premiere-material-space.json.tmp-proof"), "utf8"), "evidence");
});

test("打开文件夹逐级退回已存在的位置，不创建空批次", async t => {
  const f = await fixture(t);
  const media = path.join(f.root, "素材"), batch = path.join(media, "2026年9月30日添加素材");
  assert.equal(await W.nearestDirectory(fs, [batch, media, f.root]), f.root);
  await fs.mkdir(media);
  assert.equal(await W.nearestDirectory(fs, [batch, media, f.root]), media);
  assert.deepEqual(await fs.readdir(media), []);
  await fs.writeFile(batch, "occupied");
  await assert.rejects(W.nearestDirectory(fs, [batch, media, f.root]), /不是普通文件夹/);
});
