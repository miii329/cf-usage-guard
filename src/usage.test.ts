import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchUsage, readUsage } from "./usage";

test("バケットごとにいちばん新しい保存量を足し、操作を Class A・B に分けて数える", () => {
  const usage = readUsage({
    data: {
      viewer: {
        accounts: [
          {
            storage: [
              {
                max: { payloadSize: 300, metadataSize: 10 },
                dimensions: {
                  bucketName: "a",
                  datetime: "2026-11-14T10:00:00Z",
                },
              },
              {
                max: { payloadSize: 200, metadataSize: 5 },
                dimensions: {
                  bucketName: "b",
                  datetime: "2026-11-14T09:00:00Z",
                },
              },
              // a の古い値は使わない
              {
                max: { payloadSize: 999, metadataSize: 0 },
                dimensions: {
                  bucketName: "a",
                  datetime: "2026-11-13T10:00:00Z",
                },
              },
            ],
            operations: [
              {
                sum: { requests: 40 },
                dimensions: { actionType: "PutObject" },
              },
              {
                sum: { requests: 2 },
                dimensions: { actionType: "ListObjects" },
              },
              {
                sum: { requests: 500 },
                dimensions: { actionType: "GetObject" },
              },
              {
                sum: { requests: 7 },
                dimensions: { actionType: "HeadObject" },
              },
              {
                sum: { requests: 9 },
                dimensions: { actionType: "DeleteObject" },
              },
            ],
          },
        ],
      },
    },
  });
  assert.deepEqual(usage, { storageBytes: 515, classA: 42, classB: 507 });
});

test("エラーやアカウントがない答えは読み取れない", () => {
  assert.equal(readUsage({ errors: [{ message: "denied" }] }), null);
  assert.equal(readUsage({ data: { viewer: { accounts: [] } } }), null);
});

test("今月の初めからの操作と、直近2日の保存量を問い合わせる", async () => {
  let sent: { variables: Record<string, string> } | undefined;
  let auth: string | null = null;
  const usage = await fetchUsage({
    accountId: "acc",
    apiToken: "token",
    now: new Date("2026-11-14T10:00:00Z"),
    fetch: async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      auth = new Headers(init?.headers).get("Authorization");
      return Response.json({
        data: { viewer: { accounts: [{ storage: [], operations: [] }] } },
      });
    },
  });
  assert.deepEqual(usage, { storageBytes: 0, classA: 0, classB: 0 });
  assert.equal(auth, "Bearer token");
  assert.equal(sent?.variables.accountTag, "acc");
  assert.equal(sent?.variables.monthStart, "2026-11-01T00:00:00.000Z");
  assert.equal(sent?.variables.storageStart, "2026-11-12T10:00:00.000Z");
});

test("API がエラーを返したら例外にする", async () => {
  await assert.rejects(
    fetchUsage({
      accountId: "acc",
      apiToken: "t",
      now: new Date(),
      fetch: async () => new Response("", { status: 403 }),
    }),
    /HTTP 403/,
  );
  await assert.rejects(
    fetchUsage({
      accountId: "acc",
      apiToken: "t",
      now: new Date(),
      fetch: async () =>
        Response.json({ errors: [{ message: "not authorized" }] }),
    }),
    /not authorized/,
  );
});
