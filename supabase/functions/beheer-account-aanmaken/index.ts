// Edge function voor het nieuwe schoolbeheer-scherm (beheer.html):
// maakt een echt inlogaccount aan (auth.users + profiles). Dit MOET
// server-side met de service-role sleutel - de browser mag die nooit
// zien, dus zelfs een administrator kan dit niet rechtstreeks via RLS.
// JWT-geverifieerd; alleen de rol 'administrator' mag dit aanroepen
// (zelf gecontroleerd, want de auth-check hieronder loopt via de
// eigen sessie van de aanroeper, niet via de service-role).
import { createClient } from 'npm:@supabase/supabase-js@2.115.0';
import { corsHeaders, json } from '../_shared/api.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';

const GELDIGE_ROLLEN = [
  'administrator', 'directie', 'teamleider', 'mentor', 'vakdocent',
  'surveillant', 'verzuimcoordinator', 'zorgcoordinator',
  'kwaliteitsmedewerker', 'ouder', 'leerling',
];

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
    const { data: eigenProfiel } = await asUser.from('profiles').select('role, school_id').eq('id', user.id).maybeSingle();
    if (!eigenProfiel || eigenProfiel.role !== 'administrator') return json({ error: 'Alleen een administrator mag accounts aanmaken.' }, 403);

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { allowed } = await checkRateLimit(admin, `beheer-account-aanmaken:${eigenProfiel.school_id}`, 20, 60);
    if (!allowed) return json({ error: 'Te veel verzoeken. Probeer het over een minuut opnieuw.' }, 429);

    const { email, fullName, role, password } = await req.json();
    if (!email || !fullName || !role) return json({ error: 'email, fullName en role zijn verplicht.' }, 400);
    if (!GELDIGE_ROLLEN.includes(role)) return json({ error: `Onbekende rol: ${role}` }, 400);

    const wachtwoord = password || crypto.randomUUID().slice(0, 12);

    const authRes = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: wachtwoord, email_confirm: true }),
    });
    const authData = await authRes.json();
    if (!authRes.ok) return json({ error: authData.msg || authData.message || 'Kon het account niet aanmaken (bestaat het e-mailadres al?).' }, 400);

    const { error: profileError } = await admin.from('profiles').insert({
      id: authData.id, school_id: eigenProfiel.school_id, role, full_name: fullName, email,
    });
    if (profileError) {
      await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/admin/users/${authData.id}`, {
        method: 'DELETE', headers: { apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
      });
      throw profileError;
    }

    await asUser.from('audit_logs').insert({
      school_id: eigenProfiel.school_id,
      actor_profile_id: user.id,
      action: 'account.aangemaakt',
      entity_type: 'profiles',
      entity_id: authData.id,
      detail: { email, role },
    });

    return json({ ok: true, profileId: authData.id, email, password: password ? null : wachtwoord });
  } catch (err) {
    return json({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
