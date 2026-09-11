// Gedeelde rate-limit-helper voor edge functions, gebruikt de
// rate_limit_hits-tabel + increment_rate_limit_hit-RPC (zie het "NIEUW"-blok
// onderaan supabase/schema.sql). Vaste-window teller: geen externe
// dependency (Redis e.d.) nodig voor dit schaalniveau.
export async function checkRateLimit(
  supabase: { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> },
  bucketKey: string,
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number }> {
  const windowStart = new Date(
    Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000
  ).toISOString();

  const { data, error } = await supabase.rpc('increment_rate_limit_hit', {
    p_bucket_key: bucketKey,
    p_window_start: windowStart,
  });

  if (error) {
    console.error('Rate limit check mislukt, sta request toe:', error);
    return { allowed: true, remaining: limit };
  }

  const hitCount = data as number;
  return { allowed: hitCount <= limit, remaining: Math.max(0, limit - hitCount) };
}

export function clientIp(req: Request): string {
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) return forwardedFor.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}
