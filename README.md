# cf-usage-guard

Cloudflare の使用量の見張り役です。いまは R2 を見ています。R2 は使った分だけ請求されるので、無料枠を超えそうになったら、アカウント内のすべてのプロジェクトのアップロードをまとめて止めます。

## しくみ

- Worker が30分ごとに、アカウント全体の R2 の使用量を Cloudflare の GraphQL Analytics API で確かめます。
- 保存容量・書き込み回数（Class A）・読み込み回数（Class B）のどれかが無料枠の80%を超えたら、KV に「止める」と書きます。月が替わって下がったら、自動で再開します。
- 止めたとき・再開したときは、Slack に通知します。
- 使用量を3時間以上確かめられない（APIトークンの期限切れなど）ときも、アップロードは止まります。そのことも Slack に通知します。

| 無料枠（1か月）              | 止める目安（80%） |
| ---------------------------- | ----------------- |
| 保存容量 10GB                | 8GB               |
| 書き込み（Class A）100万回   | 80万回            |
| 読み込み（Class B）1,000万回 | 800万回           |

## アップロードする側での使い方

1. `src/flag.ts` を、アップロードを受け付けるプロジェクトにコピーします（`src/usage.ts` の `Usage` 型も使うので、型だけ一緒にコピーするか置き換えます）。
2. そのプロジェクトの Worker に、同じ KV をつなぎます（`kv_namespaces` に同じ Namespace ID）。
3. アップロードを受け付ける前に確かめます。

```ts
const check = await isUploadAllowed(env.QUOTA);
if (!check.ok) return new Response(check.reason, { status: 503 });
```

状態がない・古い・壊れているときは、止める側に倒します。

## セットアップ

1. Cloudflare のダッシュボードで KV（Workers KV）を1つ作ります。
2. `wrangler.example.jsonc` を `wrangler.jsonc` にコピーし、KV の Namespace ID とアカウントIDを書きます。`wrangler.jsonc` はコミットしません。
3. 「Account Analytics：読み取り」だけの権限を持つ API トークンを作ります。Slack の Incoming Webhook の URL も用意します（なければ通知はログだけ）。
4. シークレットを登録して公開します。

   ```bash
   pnpm install
   pnpm wrangler login
   pnpm wrangler secret put CF_API_TOKEN
   pnpm wrangler secret put SLACK_WEBHOOK_URL
   pnpm run deploy
   ```

5. 動作を確かめます。`.dev.vars` に `CF_API_TOKEN=…` を書いてから `pnpm dev` を実行し、別のターミナルで `curl "http://localhost:8787/__scheduled"` を開くと1回動きます。ログの使用量が、ダッシュボードの R2 の「Metrics」と合っていれば正しく動いています。
6. ダッシュボードで請求の通知（Billing notifications）を設定し、月に1回は R2 の「Metrics」で使用量を見ます。

## 開発

```bash
pnpm test
pnpm typecheck
pnpm format
```
# cf-usage-guard
