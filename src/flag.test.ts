import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  guardBucket,
  guardKey,
  resetAnnounced,
  UploadBlockedError,
  type GuardState,
} from "./flag";

const t0 = new Date("2026-11-14T00:00:00Z");
const hour = 60 * 60 * 1000;

function kvWith(state: Partial<GuardState> | null) {
  const raw =
    state &&
    JSON.stringify({
      stopped: false,
      reason: null,
      checkedAt: t0.toISOString(),
      usage: { storageBytes: 0, classA: 0, classB: 0 },
      staleAlerted: false,
      ...state,
    });
  return { get: async (key: string) => (key === guardKey ? raw : null) };
}

function fakeBucket() {
  const puts: string[] = [];
  return {
    puts,
    async put(key: string, _body: string) {
      puts.push(key);
      return { key };
    },
    async createMultipartUpload(key: string) {
      puts.push(`multipart:${key}`);
      return { key };
    },
    async get(key: string) {
      return { key };
    },
  };
}

beforeEach(() => resetAnnounced());

test("止めていなければ、そのまま R2 に送る", async () => {
  const bucket = fakeBucket();
  const sent: string[] = [];
  const guarded = guardBucket(bucket, kvWith({}), {
    announce: (t) => void sent.push(t),
    now: () => t0,
  });
  assert.deepEqual(await guarded.put("a.png", "x"), { key: "a.png" });
  assert.deepEqual(bucket.puts, ["a.png"]);
  assert.deepEqual(sent, []);
});

test("止めているときは R2 に送らずにエラーにし、知らせる", async () => {
  const bucket = fakeBucket();
  const sent: string[] = [];
  const guarded = guardBucket(
    bucket,
    kvWith({ stopped: true, reason: "保存容量が80%を超えました" }),
    { announce: (t) => void sent.push(t), project: "KnowMe", now: () => t0 },
  );
  await assert.rejects(guarded.put("a.png", "x"), UploadBlockedError);
  await assert.rejects(
    guarded.createMultipartUpload("big.mp4"),
    /保存容量が80%を超えました/,
  );
  assert.deepEqual(bucket.puts, []);
  // 同じ理由は1回だけ知らせる
  assert.equal(sent.length, 1);
  assert.match(sent[0], /🚫 ［KnowMe］R2へのアップロードを止めました/);
  assert.match(sent[0], /保存容量が80%を超えました/);
});

test("読み込みは止めない", async () => {
  const guarded = guardBucket(fakeBucket(), kvWith({ stopped: true }));
  assert.deepEqual(await guarded.get("a.png"), { key: "a.png" });
});

test("印がない・3時間以上古いときも止めて知らせる", async () => {
  const sent: string[] = [];
  const announce = (t: string) => void sent.push(t);
  await assert.rejects(
    guardBucket(fakeBucket(), kvWith(null), { announce, now: () => t0 }).put(
      "a",
      "x",
    ),
    /まだ確かめていない/,
  );
  await assert.rejects(
    guardBucket(fakeBucket(), kvWith({}), {
      announce,
      now: () => new Date(t0.getTime() + 3 * hour),
    }).put("a", "x"),
    /確かめられていない/,
  );
  assert.equal(sent.length, 2);
});

test("1時間たったら、もう一度知らせる。waitUntil があれば待たずに返す", async () => {
  const sent: string[] = [];
  const waited: Promise<unknown>[] = [];
  let now = t0;
  const guarded = guardBucket(fakeBucket(), kvWith({ stopped: true }), {
    announce: (t) => void sent.push(t),
    waitUntil: (p) => void waited.push(p),
    now: () => now,
  });
  await assert.rejects(guarded.put("a", "x"));
  now = new Date(t0.getTime() + 0.5 * hour);
  await assert.rejects(guarded.put("a", "x"));
  now = new Date(t0.getTime() + 1 * hour);
  await assert.rejects(guarded.put("a", "x"));
  await Promise.all(waited);
  assert.equal(sent.length, 2);
  assert.equal(waited.length, 3);
});

test("知らせるのに失敗しても、止めるエラーはそのまま返す", async () => {
  const guarded = guardBucket(fakeBucket(), kvWith({ stopped: true }), {
    announce: async () => {
      throw new Error("Slack down");
    },
    now: () => t0,
  });
  await assert.rejects(guarded.put("a", "x"), UploadBlockedError);
});
