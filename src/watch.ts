// 見張り役の1回分の処理。使用量を確かめて、止めるか決め、KV に書き、変わったときに通知する
import { guardKey, parseState, staleAfterMs, type GuardState } from "./flag";
import { freeTier, type Usage } from "./usage";

// 無料枠のこの割合を超えたら止める
export const stopRatio = 0.8;

export type GuardStore = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};

const labels: Record<keyof Usage, string> = {
  storageBytes: "保存容量",
  classA: "書き込み回数",
  classB: "読み込み回数",
};

function format(key: keyof Usage, value: number): string {
  if (key === "storageBytes") return `${(value / 1e9).toFixed(2)}GB`;
  return `${value.toLocaleString("en-US")}回`;
}

// 使用量と無料枠を並べた文（通知用）
export function describeUsage(usage: Usage): string {
  return (Object.keys(labels) as (keyof Usage)[])
    .map((k) => {
      const percent = Math.round((usage[k] / freeTier[k]) * 100);
      return `${labels[k]} ${format(k, usage[k])} / ${format(k, freeTier[k])}（${percent}%）`;
    })
    .join("\n");
}

// 8割を超えている項目があれば、その理由。なければ null
export function overLimit(usage: Usage): string | null {
  const over = (Object.keys(labels) as (keyof Usage)[]).filter(
    (k) => usage[k] >= freeTier[k] * stopRatio,
  );
  if (over.length === 0) return null;
  return `R2の${over.map((k) => labels[k]).join("・")}が無料枠の${stopRatio * 100}%を超えたため、アップロードを止めています`;
}

export async function runWatch(deps: {
  store: GuardStore;
  readUsage: () => Promise<Usage>;
  notify: (text: string) => Promise<void>;
  now: Date;
}): Promise<GuardState | null> {
  const { store, now } = deps;
  const previous = parseState(await store.get(guardKey));

  let usage: Usage;
  try {
    usage = await deps.readUsage();
  } catch (error) {
    console.error("R2の使用量を読み取れませんでした", error);
    // 読めないまま一定時間たったら、アップロード側は止める。そのことを1回だけ通知する
    const lastChecked = previous ? new Date(previous.checkedAt).getTime() : 0;
    const stale = now.getTime() - lastChecked >= staleAfterMs;
    if (stale && previous && !previous.staleAlerted) {
      await safeNotify(
        deps.notify,
        `⚠️ R2の使用量を3時間以上確かめられていないため、アップロードを止めています。\nAPIトークンの期限・権限を確かめてください。\n${String(error)}`,
      );
      await store.put(
        guardKey,
        JSON.stringify({ ...previous, staleAlerted: true }),
      );
    }
    return previous;
  }

  const reason = overLimit(usage);
  const state: GuardState = {
    stopped: reason !== null,
    reason,
    checkedAt: now.toISOString(),
    usage,
    staleAlerted: false,
  };
  await store.put(guardKey, JSON.stringify(state));

  const detail = describeUsage(usage);
  if (state.stopped && !previous?.stopped) {
    await safeNotify(deps.notify, `🛑 ${reason}\n${detail}`);
  } else if (!state.stopped && previous?.stopped) {
    await safeNotify(
      deps.notify,
      `✅ R2のアップロードを再開しました\n${detail}`,
    );
  } else if (previous?.staleAlerted) {
    await safeNotify(
      deps.notify,
      `✅ R2の使用量を再び確かめられるようになりました\n${detail}`,
    );
  }
  return state;
}

// 通知に失敗しても、見張りそのものは止めない
async function safeNotify(
  notify: (text: string) => Promise<void>,
  text: string,
) {
  try {
    await notify(text);
  } catch (error) {
    console.error("通知を送れませんでした", error);
  }
}
