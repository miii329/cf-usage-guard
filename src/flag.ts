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
