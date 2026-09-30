(function (root, factory) {
  "use strict";
  var api = factory(typeof module !== "undefined" && module.exports ? require("./core") : root.MaterialBatchCore);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MaterialBatchPreferences = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Core) {
  "use strict";
  var CACHE_KEY = "hechao.material-batch-organizer.protection.v1";
  function empty() { return { schemaVersion: 1, confirmed: false, mappings: [], removedIds: [] }; }
  function validate(value) {
    if (value && value.schemaVersion > 1) {
      var error = new Error("不搬动名单由较新版本保存，请使用新版插件读取");
      error.preventBackupFallback = true;
      throw error;
    }
    return Boolean(value && value.schemaVersion === 1 && typeof value.confirmed === "boolean"
      && Array.isArray(value.mappings) && Array.isArray(value.removedIds)
      && value.removedIds.every(function (id) { return typeof id === "string" && id; })
      && value.mappings.every(function (m) { return m && typeof m.libraryId === "string" && m.libraryId
        && typeof m.label === "string" && Core.isAbsoluteLocalPath(m.rootPath); })
      && new Set(value.mappings.map(function (m) { return m.libraryId; })).size === value.mappings.length);
  }
  function migrate(settings) {
    var value = empty();
    value.mappings = (settings.protectedMappings || []).filter(function (m) { return Core.isAbsoluteLocalPath(m.rootPath); });
    value.confirmed = value.mappings.length > 0 || Object.keys(settings.protectedRevisionByProject || {}).length > 0;
    if (!validate(value)) throw new Error("旧版不搬动名单无法完整读取，未用空名单替代");
    return value;
  }
  function libraries(profile, projectLibraries) {
    var result = [], seen = new Set();
    (profile.mappings || []).concat(projectLibraries || []).forEach(function (m) {
      if (seen.has(m.libraryId) || profile.removedIds.indexOf(m.libraryId) >= 0) return;
      seen.add(m.libraryId); result.push({ libraryId: m.libraryId, label: m.label });
    });
    return result;
  }
  function mappings(profile) {
    return profile.mappings.slice();
  }
  function withMapping(profile, mapping) {
    return Object.assign({}, profile, { confirmed: true,
      mappings: profile.mappings.filter(function (m) { return m.libraryId !== mapping.libraryId; }).concat([mapping]),
      removedIds: profile.removedIds.filter(function (id) { return id !== mapping.libraryId; }) });
  }
  function withoutMapping(profile, id) {
    return Object.assign({}, profile, { mappings: profile.mappings.filter(function (m) { return m.libraryId !== id; }),
      removedIds: Array.from(new Set(profile.removedIds.concat([id]))) });
  }
  function createStore(options) {
    var revision, recovered = false, path, loadedOnce = false;
    async function load(legacy) {
      path = await options.resolvePath();
      var value;
      if (path) {
        var loaded = await options.storage.readJsonWithBackup(options.fs, path, { validate: validate });
        revision = loaded.revision; recovered = loaded.recovered;
        if (!loaded.missing) value = loaded.value;
      }
      if (!value) {
        var cached = options.cache.getItem(CACHE_KEY);
        value = cached ? JSON.parse(cached) : migrate(legacy);
        if (!validate(value)) throw new Error("本机不搬动名单格式异常，未用空名单替代");
        loadedOnce = true;
        if (path && value.confirmed) await save(value);
      }
      loadedOnce = true;
      return value;
    }
    async function save(value) {
      if (!loadedOnce) throw new Error("请先读取本机不搬动名单，未覆盖已有设置");
      if (!validate(value)) throw new Error("不搬动名单格式异常，未保存");
      if (path) {
        var saved = await options.storage.writeJsonAtomic(options.fs, path, value, { expectedRevision: revision, recovered: recovered });
        revision = saved.revision; recovered = false;
        if (saved.warning) throw new Error("本机名单已写入，但保存复核未完成，请重新检查");
        // 磁盘是权威副本，面板缓存丢失不应让已保存名单消失。
        try { options.cache.setItem(CACHE_KEY, JSON.stringify(value)); } catch (_) {}
      } else options.cache.setItem(CACHE_KEY, JSON.stringify(value));
    }
    return { load: load, save: save };
  }
  return { CACHE_KEY: CACHE_KEY, empty: empty, validate: validate, migrate: migrate,
    libraries: libraries, mappings: mappings, withMapping: withMapping, withoutMapping: withoutMapping, createStore: createStore };
});
