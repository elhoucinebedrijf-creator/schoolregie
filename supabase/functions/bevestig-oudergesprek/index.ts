// Edge function voor de ouder/leerling-UI (Fase 3): bevestigt een
// voorgesteld oudergesprek. GEEN brede update-RLS-policy voor deze rol op
// `conversations` (RLS is rij-niveau, niet kolom-niveau - dan zou een
// ouder ook scheduled_at/status/kind kunnen wijzigen, niet alleen
// bevestigen) - daarom hier een smalle, JWT-geverifieerde functie die
// eigenaarschap eerst via de RLS-select van de aanroeper controleert en
// pas dan met de service-role precies één kolom zet.
import { createClient } from 'npm:@supabase/supabase-js@2.115.0';
import { corsHeaders, json } from '../_shared/api.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Niet ingelogd.' }, 401);

    const asUser = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: 'Niet ingelogd.' }, 401);
    const { allowed } = await checkRateLimit(admin, `bevestig-oudergesprek:${user.id}`, 20, 60);
    if (!allowed) return json({ error: 'Te veel verzoeken. Probeer het over een minuut opnieuw.' }, 429);

    const { conversationId } = await req.json();
    if (!conversationId) return json({ error: 'conversationId is verplicht.' }, 400);

    // RLS (conversations_own_select) zorgt dat dit alleen iets teruggeeft
    // als de ingelogde gebruiker leerling is of ouder/verzorger van de
    // leerling bij dit gesprek.
    const { data: conversation } = await asUser.from('conversations').select('conversation_id, scheduled_at, status').eq('conversation_id', conversationId).maybeSingle();
    if (!conversation) return json({ error: 'Gesprek niet gevonden of geen toegang.' }, 404);
    if (!conversation.scheduled_at) return json({ error: 'Er is nog geen datum/tijd voorgesteld om te bevestigen.' }, 400);

    const { error } = await admin.from('conversations').update({ confirmed_by_guardian: true }).eq('conversation_id', conversationId);
    if (error) throw error;

    return json({ ok: true, conversationId });
  } catch (err) {
    return json({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
