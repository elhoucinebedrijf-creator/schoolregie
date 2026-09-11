// Edge function voor de cockpit-UI (Fase 6): zet ruwe weekcijfers (al
// door de browser opgehaald via RLS - geen geheime data hier nodig) om
// in een leesbaar managementrapport. Zelfde reden als de andere
// genereer-*-functies: de ANTHROPIC_API_KEY moet server-side blijven.
import { createClient } from 'npm:@supabase/supabase-js@2.115.0';
import { corsHeaders, json, parseClaudeJson } from '../_shared/api.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Niet ingelogd.' }, 401);

    // De header-aanwezigheid werd hier eerder alleen gecontroleerd, niet
    // geverifieerd - elk niet-leeg Authorization-veld kwam er doorheen.
    // Nu wel echt valideren via Supabase Auth vóór de (betaalde) AI-aanroep.
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: 'Niet ingelogd.' }, 401);

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { allowed } = await checkRateLimit(admin, `genereer-managementrapport:${user.id}`, 15, 60);
    if (!allowed) return json({ error: 'Te veel verzoeken. Probeer het over een minuut opnieuw.' }, 429);

    const metrics = await req.json();

    const system = `Je bent een data-analist die een wekelijks managementrapport schrijft voor de directie/teamleiding van een middelbare school, gebaseerd op cijfers uit SchoolRegie. Schrijf zakelijk, feitelijk en beknopt (200-300 woorden), noem concrete getallen, en sluit af met de belangrijkste aandachtspunten. Geen markdown-opmaak.

Antwoord UITSLUITEND met geldige JSON: {"reportText": "het volledige rapport als platte tekst, in het Nederlands"}`;
    const user = `Cijfers van deze week: ${JSON.stringify(metrics)}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 1500, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error(`Claude-aanroep faalde: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const tekst = (data.content || []).map((c: { text?: string }) => c.text || '').join('\n');
    const parsed = parseClaudeJson<{ reportText?: string }>(tekst, { reportText: 'Kon het AI-antwoord niet als JSON parsen - controleer handmatig.' });

    return json({ ok: true, reportText: parsed.reportText || '' });
  } catch (err) {
    return json({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
