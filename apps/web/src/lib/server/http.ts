import "server-only";
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { StoreUnavailable } from "./store";

export const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export const fail = (status: number, error: string) => json({ error }, status);

/** Parses a JSON body of at most `maxBytes`, or returns an error response. */
export async function readJson(req: Request, maxBytes: number): Promise<{ body: Record<string, unknown> } | { error: NextResponse }> {
  const text = await req.text();
  if (text.length > maxBytes) return { error: fail(413, `Request body over ${maxBytes} bytes`) };
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) return { error: fail(400, "Expected a JSON object") };
    return { body };
  } catch {
    return { error: fail(400, "Body is not valid JSON") };
  }
}

/** The operator authenticates with `Authorization: Bearer <OPERATOR_TOKEN>`. */
export function operatorAuth(req: Request): NextResponse | null {
  const expected = process.env.OPERATOR_TOKEN;
  if (!expected) return fail(503, "Operator token is not configured on this deployment");
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return fail(401, "Unauthorized");
  return null;
}

/** Turns storage outages into a 503 instead of a crash. */
export async function guarded(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StoreUnavailable) return fail(503, e.message);
    console.error(e);
    return fail(500, "Internal error");
  }
}

export const ROLLUP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
