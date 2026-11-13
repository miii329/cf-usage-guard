// Slack の Incoming Webhook に通知を送る。URL がなければ送らない（ログだけ）
export function slackNotifier(
  webhookUrl: string | undefined,
  doFetch: typeof fetch = fetch,
) {
  return async (text: string) => {
    console.log(text);
    if (!webhookUrl) return;
    const res = await doFetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`Slack: HTTP ${res.status}`);
  };
}
