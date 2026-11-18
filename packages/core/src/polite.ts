// A fetch for the public QoreChain endpoints that stays within their rate limits: requests from
// one process are spaced out, and a 429 or a 5xx is retried with exponential backoff (honouring
// Retry-After). Every REST read in Wicketgate goes through it.
const MIN_GAP_MS = Number(process.env.WICKETGATE_MIN_GAP_MS ?? 120); // about 8 requests a second per process
const MAX_TRIES = 6;
let next = 0;

async function slot() {
  const now = Date.now();
  const at = Math.max(now, next);
  next = at + MIN_GAP_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

export async function politeFetch(url: string, init: Record<string, any> = {}): Promise<Response> {
  const headers = { "User-Agent": "wicketgate/0.2", ...(init.headers ?? {}) };
  let wait = 1000;
  for (let attempt = 1; ; attempt++) {
    await slot();
    let res: Response | undefined;
    try {
      res = await fetch(url, { ...init, headers });
    } catch (e) {
      if (attempt >= MAX_TRIES) throw e; // network error: retry a few times, then give up loudly
    }
    if (res && res.status !== 429 && res.status < 500) return res;
    if (res && attempt >= MAX_TRIES) return res;
    const retryAfter = Number(res?.headers.get("retry-after"));
    await new Promise((r) => setTimeout(r, retryAfter > 0 ? retryAfter * 1000 : wait));
    wait = Math.min(wait * 2, 30_000);
  }
}
