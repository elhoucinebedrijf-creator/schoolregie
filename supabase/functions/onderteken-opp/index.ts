// Edge function voor de ouder/leerling/mentor-UI (Fase 9): digitaal akkoord
// geven op een OPP-plan waarvoor een ondertekenverzoek openstaat. GEEN
// brede update-RLS-policy voor deze rollen op `opp_signatures` (RLS is
// rij-niveau, niet kolom-niveau) - daarom, zelfde patroon als
// `bevestig-oudergesprek`, een smalle JWT-geverifieerde functie die
// eigenaarschap eerst via de RLS-select van de aanroeper controleert en
// pas dan met de service-role precies status/signed_at/signed_name zet.
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
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: 'Niet ingelogd.' }, 401);

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { allowed } = await checkRateLimit(admin, `onderteken-opp:${user.id}`, 20, 60);
    if (!allowed) return json({ error: 'Te veel verzoeken. Probeer het over een minuut opnieuw.' }, 429);

    const { signatureId, signedName } = await req.json();
    if (!signatureId) return json({ error: 'signatureId is verplicht.' }, 400);
    if (!signedName || !signedName.trim()) return json({ error: 'signedName is verplicht.' }, 400);

    // RLS (opp_signatures_own_select) zorgt dat dit alleen iets teruggeeft
    // als de ingelogde gebruiker zelf de aangeschreven leerling/mentor is,
    // of ouder/verzorger van de leerling bij dit OPP-plan.
    const { data: signature } = await asUser.from('opp_signatures').select('signature_id, status').eq('signature_id', signatureId).maybeSingle();
    if (!signature) return json({ error: 'Ondertekenverzoek niet gevonden of geen toegang.' }, 404);
    if (signature.status === 'akkoord') return json({ error: 'Dit is al ondertekend.' }, 400);

    const { error } = await admin
      .from('opp_signatures')
      .update({ status: 'akkoord', signed_at: new Date().toISOString(), signed_name: signedName.trim() })
      .eq('signature_id', signatureId);
    if (error) throw error;

    return json({ ok: true, signatureId });
  } catch (err) {
    return json({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
