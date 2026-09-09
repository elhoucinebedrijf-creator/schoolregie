// Publieke edge function (Fase 10) - GEEN JWT, GEEN X-SchoolRegie-Key: de
// aanroeper is per definitie niet ingelogd (klikt een link in een e-mail).
// Autorisatie loopt volledig via een eenmalig bruikbaar, tijdelijk token
// (`confirm_token` op conversations/opp_signatures) dat al bestond op de
// rij vóórdat deze functie ooit aangeroepen wordt - er wordt hier nooit
// een token uitgegeven, alleen gevalideerd en verbruikt.
//
// GET valideert alleen en toont weergave-info (veilig/idempotent, zodat
// een e-mail-scanner die de link prefetcht niets kan veranderen). POST
// voert de echte wijziging door en maakt het token meteen ongeldig.
import { createClient } from 'npm:@supabase/supabase-js@2.115.0';
import { corsHeaders, json } from '../_shared/api.ts';

type Admin = ReturnType<typeof createClient>;

async function notifyStaff(admin: Admin, opts: { schoolId: string; profileId: string; studentId?: string | null; subject: string; body: string; templateKey: string }) {
  await admin.from('communications').insert({
    school_id: opts.schoolId, recipient_profile_id: opts.profileId, student_id: opts.studentId || null,
    channel: 'email', template_key: opts.templateKey, subject: opts.subject, body: opts.body, status: 'nieuw',
  });
}

async function laadGesprek(admin: Admin, token: string) {
  const { data } = await admin
    .from('conversations')
    .select('conversation_id, school_id, student_id, scheduled_at, status, confirmed_by_guardian, proposed_by, confirm_token_expires_at, students(full_name)')
    .eq('confirm_token', token)
    .maybeSingle();
  return data;
}

async function laadOpp(admin: Admin, token: string) {
  const { data } = await admin
    .from('opp_signatures')
    .select('signature_id, school_id, opp_id, status, confirm_token_expires_at, opp_plans(ai_summary, student_id, started_by, students(full_name))')
    .eq('confirm_token', token)
    .maybeSingle();
  return data;
}

function tokenGeldig(expiresAt: string | null | undefined) {
  return Boolean(expiresAt) && new Date(expiresAt as string).getTime() > Date.now();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const type = url.searchParams.get('type');
      const token = url.searchParams.get('token');
      if (!token || !['gesprek', 'opp'].includes(type || '')) return json({ error: 'Ongeldige link.' }, 400);

      if (type === 'gesprek') {
        const gesprek = await laadGesprek(admin, token);
        if (!gesprek || !tokenGeldig(gesprek.confirm_token_expires_at)) return json({ valid: false, reason: 'Deze link is niet (meer) geldig.' });
        if (gesprek.confirmed_by_guardian) return json({ valid: false, reason: 'Dit gesprek is al bevestigd.' });
        return json({
          valid: true, type: 'gesprek', studentNaam: gesprek.students?.full_name || '',
          voorgesteldMoment: gesprek.scheduled_at, status: gesprek.status,
        });
      }
      const opp = await laadOpp(admin, token);
      if (!opp || !tokenGeldig(opp.confirm_token_expires_at)) return json({ valid: false, reason: 'Deze link is niet (meer) geldig.' });
      if (opp.status !== 'nieuw') return json({ valid: false, reason: 'Hier is al op gereageerd.' });
      return json({
        valid: true, type: 'opp', studentNaam: opp.opp_plans?.students?.full_name || '',
        samenvatting: opp.opp_plans?.ai_summary || '',
      });
    }

    if (req.method === 'POST') {
      const { type, token, actie, naam, toelichting } = await req.json();
      if (!token || !['gesprek', 'opp'].includes(type)) return json({ error: 'Ongeldige aanvraag.' }, 400);
      if (!['akkoord', 'afwijzen'].includes(actie)) return json({ error: 'actie moet akkoord of afwijzen zijn.' }, 400);

      if (type === 'gesprek') {
        const gesprek = await laadGesprek(admin, token);
        if (!gesprek || !tokenGeldig(gesprek.confirm_token_expires_at) || gesprek.confirmed_by_guardian) {
          return json({ error: 'Deze link is niet (meer) geldig.' }, 410);
        }
        if (actie === 'akkoord') {
          const { error } = await admin.from('conversations').update({ confirmed_by_guardian: true, confirm_token: null }).eq('conversation_id', gesprek.conversation_id);
          if (error) throw error;
        } else {
          const { error } = await admin.from('conversations').update({ status: 'nieuw', scheduled_at: null, confirm_token: null }).eq('conversation_id', gesprek.conversation_id);
          if (error) throw error;
          if (gesprek.proposed_by) {
            await notifyStaff(admin, {
              schoolId: gesprek.school_id, profileId: gesprek.proposed_by, studentId: gesprek.student_id,
              subject: `Voorgesteld gesprek afgewezen: ${gesprek.students?.full_name || ''}`,
              body: `Het voorgestelde moment voor het oudergesprek met ${gesprek.students?.full_name || 'de leerling'} is afgewezen. Stel een nieuw moment voor.`,
              templateKey: 'conversation_declined',
            });
          }
        }
        return json({ ok: true, type: 'gesprek', actie });
      }

      const opp = await laadOpp(admin, token);
      if (!opp || !tokenGeldig(opp.confirm_token_expires_at) || opp.status !== 'nieuw') {
        return json({ error: 'Deze link is niet (meer) geldig.' }, 410);
      }
      if (actie === 'akkoord') {
        if (!naam || !String(naam).trim()) return json({ error: 'naam is verplicht.' }, 400);
        const { error } = await admin.from('opp_signatures').update({
          status: 'akkoord', signed_at: new Date().toISOString(), signed_name: String(naam).trim(), confirm_token: null,
        }).eq('signature_id', opp.signature_id);
        if (error) throw error;
      } else {
        const { error } = await admin.from('opp_signatures').update({
          status: 'afgewezen', rejection_reason: toelichting ? String(toelichting).trim() : null, confirm_token: null,
        }).eq('signature_id', opp.signature_id);
        if (error) throw error;
        if (opp.opp_plans?.started_by) {
          await notifyStaff(admin, {
            schoolId: opp.school_id, profileId: opp.opp_plans.started_by, studentId: opp.opp_plans.student_id,
            subject: `OPP niet akkoord: ${opp.opp_plans?.students?.full_name || ''}`,
            body: `Er is niet akkoord gegeven op het OPP-plan van ${opp.opp_plans?.students?.full_name || 'de leerling'}.${toelichting ? ` Toelichting: ${toelichting}` : ' Geen toelichting gegeven.'}`,
            templateKey: 'opp_signature_rejected',
          });
        }
      }
      return json({ ok: true, type: 'opp', actie });
    }

    return json({ error: 'Methode niet ondersteund.' }, 405);
  } catch (err) {
    return json({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
