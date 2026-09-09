// Gedeelde helpers voor de n8n-gerichte edge functions van SchoolRegie -
// zelfde patroon als _shared/quality.ts in KwaliteitsKompas.

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-schoolregie-key',
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// Claude volgt de "antwoord uitsluitend met JSON"-instructie bijna altijd,
// maar soms glipt er toch een ```json-codeblok of een stray zin voor/na de
// JSON doorheen - pak daarom het eerste {...}-blok eruit vóór het parsen
// i.p.v. de ruwe tekst direct te parsen.
export function parseClaudeJson<T>(tekst: string, fallback: T): T {
  const match = tekst.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return fallback;
  }
}

// n8n heeft geen ingelogde gebruiker/sessie - gedeeld geheim in de
// X-SchoolRegie-Key-header (vergeleken met de Supabase-secret API_KEY),
// zoals de spec expliciet vraagt.
export function requireApiKey(req: Request): Response | null {
  const verwacht = Deno.env.get('API_KEY');
  const meegegeven = req.headers.get('X-SchoolRegie-Key') || req.headers.get('x-schoolregie-key');
  if (!verwacht || !meegegeven || meegegeven !== verwacht) {
    return json({ error: 'Ongeldige of ontbrekende API-sleutel.' }, 401);
  }
  return null;
}
