// Cloudflare の GraphQL Analytics API で、アカウント全体の R2 の使用量を読む。
// https://developers.cloudflare.com/r2/platform/metrics-analytics/
// API トークンには「Account Analytics：読み取り」の権限が必要。数字は少し遅れて反映される

export type Usage = {
  // 保存している容量（バイト）。全バケットの合計
  storageBytes: number;
  // 今月の書き込み系の操作（Class A）の回数
  classA: number;
  // 今月の読み込み系の操作（Class B）の回数
  classB: number;
};

// 無料枠（1か月）。https://developers.cloudflare.com/r2/pricing/
// 容量は少なめに見積もるため 1GB = 10億バイトで数える
export const freeTier: Usage = {
  storageBytes: 10 * 1e9,
  classA: 1_000_000,
  classB: 10_000_000,
};

// 読み込み系（Class B）の操作。https://developers.cloudflare.com/r2/pricing/#class-b-operations
const classBActions = new Set([
  "HeadBucket",
  "HeadObject",
  "GetObject",
  "UsageSummary",
  "GetBucketEncryption",
  "GetBucketLocation",
  "GetBucketCors",
  "GetBucketLifecycleConfiguration",
]);
// 料金のかからない操作
const freeActions = new Set([
  "DeleteObject",
  "DeleteObjects",
  "DeleteBucket",
  "AbortMultipartUpload",
]);

const query = `query R2Usage($accountTag: string!, $storageStart: Time!, $monthStart: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      storage: r2StorageAdaptiveGroups(
        limit: 10000
        filter: { datetime_geq: $storageStart, datetime_leq: $end }
        orderBy: [datetime_DESC]
      ) {
        max { payloadSize metadataSize }
        dimensions { bucketName datetime }
      }
      operations: r2OperationsAdaptiveGroups(
        limit: 10000
        filter: { datetime_geq: $monthStart, datetime_leq: $end }
      ) {
        sum { requests }
        dimensions { actionType }
      }
    }
  }
}`;

type GraphQLResponse = {
  data?: {
    viewer?: {
      accounts?: {
        storage?: {
          max?: { payloadSize?: number; metadataSize?: number };
          dimensions?: { bucketName?: string; datetime?: string };
        }[];
        operations?: {
          sum?: { requests?: number };
          dimensions?: { actionType?: string };
        }[];
      }[];
    };
  };
  errors?: { message: string }[] | null;
};

// GraphQL の答えから使用量を取り出す。読み取れなければ null
export function readUsage(body: GraphQLResponse): Usage | null {
  if (body.errors?.length) return null;
  const account = body.data?.viewer?.accounts?.[0];
  if (!account) return null;

  // 保存量は時刻の新しい順に並んでいるので、バケットごとに最初の1件（いちばん新しい値）を足す
  const seen = new Set<string>();
  let storageBytes = 0;
  for (const row of account.storage ?? []) {
    const bucket = row.dimensions?.bucketName ?? "";
    if (seen.has(bucket)) continue;
    seen.add(bucket);
    storageBytes += (row.max?.payloadSize ?? 0) + (row.max?.metadataSize ?? 0);
  }

  let classA = 0;
  let classB = 0;
  for (const row of account.operations ?? []) {
    const action = row.dimensions?.actionType ?? "";
    const requests = row.sum?.requests ?? 0;
    if (freeActions.has(action)) continue;
    if (classBActions.has(action)) classB += requests;
    else classA += requests;
  }
  return { storageBytes, classA, classB };
}

export async function fetchUsage(options: {
  accountId: string;
  apiToken: string;
  now: Date;
  fetch?: typeof fetch;
}): Promise<Usage> {
  const doFetch = options.fetch ?? fetch;
  const { now } = options;
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  // 保存量は一定の間隔で記録されるので、直近2日の中でいちばん新しい値を使う
  const storageStart = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const res = await doFetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      variables: {
        accountTag: options.accountId,
        storageStart: storageStart.toISOString(),
        monthStart: monthStart.toISOString(),
        end: now.toISOString(),
      },
    }),
  });
  if (!res.ok) throw new Error(`Cloudflare API: HTTP ${res.status}`);
  const body = (await res.json()) as GraphQLResponse;
  const usage = readUsage(body);
  if (!usage) {
    const message = body.errors?.map((e) => e.message).join(", ");
    throw new Error(
      `使用量を読み取れませんでした${message ? `: ${message}` : ""}`,
    );
  }
  return usage;
}
