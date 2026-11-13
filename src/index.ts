// R2 の使用量の見張り役。30分ごと（wrangler.jsonc の triggers）に動く
import { slackNotifier } from "./slack";
import { fetchUsage } from "./usage";
import { runWatch } from "./watch";

export interface Env {
  QUOTA: KVNamespace;
  ACCOUNT_ID: string;
  // シークレット（pnpm wrangler secret put で登録する）
  CF_API_TOKEN: string;
  SLACK_WEBHOOK_URL?: string;
}

export default {
  async scheduled(_event, env, ctx) {
    const now = new Date();
    ctx.waitUntil(
      runWatch({
        store: env.QUOTA,
        readUsage: () =>
          fetchUsage({
            accountId: env.ACCOUNT_ID,
            apiToken: env.CF_API_TOKEN,
            now,
          }),
        notify: slackNotifier(env.SLACK_WEBHOOK_URL),
        now,
      }),
    );
  },
} satisfies ExportedHandler<Env>;
