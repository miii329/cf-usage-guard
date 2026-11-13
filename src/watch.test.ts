import assert from "node:assert/strict";
import { test } from "node:test";
import { checkState, guardKey, isUploadAllowed, parseState } from "./flag";
import { freeTier, type Usage } from "./usage";
import { runWatch, type GuardStore } from "./watch";

function memoryStore(): GuardStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) {
      return data.get(key) ?? null;
    },
    async put(key, value) {
      data.set(key, value);
    },
  };
}

const low: Usage = { storageBytes: 1e9, classA: 1000, classB: 1000 };
const hour = 60 * 60 * 1000;
const t0 = new Date("2026-11-14T00:00:00Z");
const at = (h: number) => new Date(t0.getTime() + h * hour);

async function run(
  store: GuardStore,
  usage: Usage | Error,
  now: Date,
  sent: string[],
) {
  return runWatch({
    store,
    readUsage: async () => {
      if (usage instanceof Error) throw usage;
      return usage;
    },
    notify: async (text) => {
      sent.push(text);
    },
    now,
  });
}

test("8割未満なら止めず、通知もしない", async () => {
  const store = memoryStore();
  const sent: string[] = [];
  const state = await run(store, low, t0, sent);
  assert.equal(state?.stopped, false);
  assert.deepEqual(sent, []);
  assert.deepEqual(await isUploadAllowed(store, t0), { ok: true });
});

test("どれか1つでも8割を超えたら止めて1回だけ通知し、下がったら再開して通知する", async () => {
  const store = memoryStore();
  const sent: string[] = [];
  await run(store, low, at(0), sent);

  const high = { ...low, classA: freeTier.classA * 0.8 };
  await run(store, high, at(0.5), sent);
  await run(store, high, at(1), sent);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /🛑 R2の書き込み回数が無料枠の80%を超えた/);
  const check = await isUploadAllowed(store, at(1));
  assert.equal(check.ok, false);

  // 月が替わって回数が戻った
  await run(store, low, at(2), sent);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /✅ R2のアップロードを再開しました/);
  assert.deepEqual(await isUploadAllowed(store, at(2)), { ok: true });
});

test("保存容量と読み込み回数も見る", async () => {
  const sent: string[] = [];
  const storage = await run(
    memoryStore(),
    { ...low, storageBytes: 8e9 },
    t0,
    sent,
  );
  assert.match(storage?.reason ?? "", /保存容量/);
  const reads = await run(
    memoryStore(),
    { ...low, classB: 8_000_000 },
    t0,
    sent,
  );
  assert.match(reads?.reason ?? "", /読み込み回数/);
});

test("使用量を読めない間は前の状態のまま。3時間たったら止まり、1回だけ通知する", async () => {
  const store = memoryStore();
  const sent: string[] = [];
  await run(store, low, at(0), sent);

  const fail = new Error("HTTP 403");
  await run(store, fail, at(1), sent);
  assert.deepEqual(sent, []);
  assert.deepEqual(await isUploadAllowed(store, at(1)), { ok: true });

  await run(store, fail, at(3), sent);
  await run(store, fail, at(3.5), sent);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /3時間以上確かめられていない/);
  assert.equal((await isUploadAllowed(store, at(3))).ok, false);

  // 直ったら再開し、そのことも通知する
  await run(store, low, at(4), sent);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /再び確かめられるようになりました/);
  assert.deepEqual(await isUploadAllowed(store, at(4)), { ok: true });
});

test("通知に失敗しても状態は書く", async () => {
  const store = memoryStore();
  await runWatch({
    store,
    readUsage: async () => ({ ...low, storageBytes: 9e9 }),
    notify: async () => {
      throw new Error("Slack down");
    },
    now: t0,
  });
  assert.equal(parseState(store.data.get(guardKey) ?? null)?.stopped, true);
});

test("状態がない・壊れているときは止める", () => {
  assert.equal(checkState(null, t0).ok, false);
  assert.equal(parseState("{not json"), null);
});
