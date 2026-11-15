// 見張り役が KV に書く「アップロードを止めるか」の状態と、その読み方。
// アップロードを受け付ける側（KnowMe や、ほかのプロジェクト）は、このファイルをコピーし、同じ KV をつないで isUploadAllowed で確かめる

import type { Usage } from "./usage";

// KV のキー
export const guardKey = "r2-guard";
// 最後の確認からこれ以上たったら、見張りが止まっているとみなしてアップロードを止める
export const staleAfterMs = 3 * 60 * 60 * 1000;

export type GuardState = {
  // 使用量が無料枠の8割を超えて、止めているか
  stopped: boolean;
  // 止めている理由（画面やログに出す）
  reason: string | null;
  // 最後に使用量を確かめられた時刻（ISO 8601）
  checkedAt: string;
  // そのときの使用量
  usage: Usage;
  // 見張りが止まっていることを、もう通知したか
  staleAlerted: boolean;
};

// get だけあればよい（KVNamespace をそのまま渡せる）
export type GuardReader = { get(key: string): Promise<string | null> };

export function parseState(raw: string | null): GuardState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as GuardState;
    return typeof value.checkedAt === "string" ? value : null;
  } catch {
    return null;
  }
}

export type UploadCheck = { ok: true } | { ok: false; reason: string };

// アップロードを受け付けてよいか。わからないときは止める側に倒す
export function checkState(state: GuardState | null, now: Date): UploadCheck {
  if (!state) {
    return {
      ok: false,
      reason: "使用量をまだ確かめていないため、アップロードを止めています",
    };
  }
  const age = now.getTime() - new Date(state.checkedAt).getTime();
  if (!(age < staleAfterMs)) {
    return {
      ok: false,
      reason: "使用量を確かめられていないため、アップロードを止めています",
    };
  }
  if (state.stopped) {
    return {
      ok: false,
      reason:
        state.reason ?? "使用量が上限に近いため、アップロードを止めています",
    };
  }
  return { ok: true };
}

export async function isUploadAllowed(
  kv: GuardReader,
  now: Date = new Date(),
): Promise<UploadCheck> {
  return checkState(parseState(await kv.get(guardKey)), now);
}

// 止めたときに投げるエラー。message はそのまま利用者に見せてよい文
export class UploadBlockedError extends Error {
  override name = "UploadBlockedError";
}

// 止めたことを知らせる先（Slack など）。同じ理由は1つの isolate で1時間に1回だけ知らせる
export const announceEveryMs = 60 * 60 * 1000;
const lastAnnounced = new Map<string, number>();

export type GuardOptions = {
  // 止めたときに知らせる。slack.ts の slackNotifier をそのまま渡せる
  announce?: (text: string) => Promise<void> | void;
  // 知らせる文に入れるプロジェクト名
  project?: string;
  // ctx.waitUntil を渡すと、知らせ終わるのを待たずにエラーを返す
  waitUntil?: (promise: Promise<unknown>) => void;
  now?: () => Date;
};

// 書き込み系の操作（Class A のうちアップロードにあたるもの）
const guardedMethods = new Set(["put", "createMultipartUpload"]);

// R2 のバケットを包み、put・createMultipartUpload の前に毎回 KV の印を見る。
// 止めるときは R2 に送らずに UploadBlockedError を投げ、announce で知らせる。
// 読み込みや削除はそのまま通す
export function guardBucket<B extends object>(
  bucket: B,
  kv: GuardReader,
  options: GuardOptions = {},
): B {
  return new Proxy(bucket, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (typeof prop !== "string" || !guardedMethods.has(prop)) {
        return value.bind(target);
      }
      return async (...args: unknown[]) => {
        const now = options.now?.() ?? new Date();
        const check = await isUploadAllowed(kv, now);
        if (!check.ok) {
          const sending = announceBlocked(check.reason, options, now);
          // waitUntil がなければ、知らせ終わってから返す（途中で打ち切られないように）
          if (options.waitUntil) options.waitUntil(sending);
          else await sending;
          throw new UploadBlockedError(check.reason);
        }
        return value.apply(target, args);
      };
    },
  });
}

async function announceBlocked(
  reason: string,
  options: GuardOptions,
  now: Date,
): Promise<void> {
  if (!options.announce) return;
  const key = `${options.project ?? ""}\n${reason}`;
  const last = lastAnnounced.get(key);
  if (last !== undefined && now.getTime() - last < announceEveryMs) return;
  lastAnnounced.set(key, now.getTime());

  const where = options.project ? `［${options.project}］` : "";
  const text = `🚫 ${where}R2へのアップロードを止めました\n${reason}`;
  try {
    await options.announce(text);
  } catch (error) {
    console.error("止めたことを知らせられませんでした", error);
  }
}

// テスト用：知らせた記録を消す
export function resetAnnounced() {
  lastAnnounced.clear();
}
