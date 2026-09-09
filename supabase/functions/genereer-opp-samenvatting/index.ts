// Edge function voor de staff-UI (Fase 4): genereert een AI-concept-
// samenvatting bij een OPP-traject. Zelfde logica als de
// opp/prepare-summary-route in api/index.ts, maar hier WEL met standaard
// Supabase-JWT-verificatie - geautoriseerd via de sessie van de
// ingelogde gebruiker + RLS i.p.v. het n8n-gedeelde geheim (zelfde
// patroon als genereer-inhaaltoets/genereer-maatwerkadvies). AI maakt
// hier UITSLUITEND een concept-samenvatting, nooit het besluit.
import { createClient } from 'npm:@supabase/supabase-js@2.115.0';
import { corsHeaders, json, parseClaudeJson } from '../_shared/api.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Niet ingelogd.' }, 401);

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { oppId, include } = await req.json();
    if (!oppId) return json({ error: 'oppId is verplicht.' }, 400);

    const { data: plan } = await supabase.from('opp_plans').select('opp_id, school_id, student_id').eq('opp_id', oppId).maybeSingle();
    if (!plan) return json({ error: 'OPP-traject niet gevonden of geen toegang.' }, 404);
    const { data: student } = await supabase.from('students').select('full_name, mentor_profile_id').eq('student_id', plan.student_id).maybeSingle();

    const categories: string[] = Array.isArray(include) && include.length ? include : ['results', 'attendance', 'interventions', 'signals', 'dossier'];
    const gathered: Record<string, unknown> = {};
    if (categories.includes('results')) {
      const [{ data: missed }, { data: maatwerk }] = await Promise.all([
        supabase.from('missed_tests').select('reason, status, created_at').eq('student_id', plan.student_id),
        supabase.from('maatwerk_assignments').select('advice_reason, status, created_at').eq('student_id', plan.student_id),
      ]);
      gathered.results = { missedTests: missed || [], maatwerkAssignments: maatwerk || [] };
    }
    if (categories.includes('attendance')) {
      const { data: events } = await supabase.from('attendance_events').select('event_type, event_date').eq('student_id', plan.student_id).order('event_date', { ascending: false }).limit(30);
      gathered.attendance = events || [];
    }
    if (categories.includes('interventions')) {
      const { data: interventions } = await supabase.from('interventions').select('kind, status, due_date, notes').eq('student_id', plan.student_id);
      gathered.interventions = interventions || [];
    }
    if (categories.includes('signals')) {
      const { data: signals } = await supabase.from('signals').select('level, trigger_type, detail, status, created_at').eq('student_id', plan.student_id);
      gathered.signals = signals || [];
    }
    if (categories.includes('dossier')) {
      const { data: dossier } = await supabase.from('dossier_entries').select('entry_type, summary, created_at').eq('student_id', plan.student_id).order('created_at', { ascending: false }).limit(20);
      gathered.dossier = dossier || [];
    }

    const system = `Je bent een ervaren zorgcoördinator-adviseur in het Nederlandse voortgezet onderwijs. Op basis van de aangeleverde gegevens (resultaten/inhaalacties, verzuim, interventies, signalen, dossier) maak je een NEUTRALE, feitelijke concept-samenvatting ter voorbereiding van een OPP-traject (ontwikkelingsperspectiefplan), plus een concreet CONCEPT-voorstel voor doelen en acties zodat de zorgcoördinator alleen nog hoeft te beoordelen/goedkeuren i.p.v. het OPP zelf te moeten opstellen. Dit blijft een concept - jij neemt NOOIT het besluit of een OPP daadwerkelijk gestart of goedgekeurd wordt; dat doet altijd een zorgcoördinator.

Antwoord UITSLUITEND met geldige JSON, geen markdown-opmaak:
{"samenvatting": "neutrale feitelijke samenvatting, 150-250 woorden, in het Nederlands", "aandachtspunten": ["puntsgewijze aandachtspunten"], "confidence": 0.0 tot 1.0, "doelen": [{"beschrijving": "concreet, haalbaar doel", "streefweken": 8}], "acties": [{"beschrijving": "concrete actie die dit doel dichterbij brengt", "doelIndex": 0, "rolSuggestie": "mentor of zorgcoordinator", "termijnDagen": 14}]}
Geef 2 tot 5 doelen en per doel 1-3 acties.`;
    const user = `Leerling: ${student?.full_name || 'onbekend'}\nGegevens: ${JSON.stringify(gathered)}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 3000, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error(`Claude-aanroep faalde: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const tekst = (data.content || []).map((c: { text?: string }) => c.text || '').join('\n');
    const parsed = parseClaudeJson<{
      samenvatting?: string; aandachtspunten?: string[]; confidence?: number;
      doelen?: Array<{ beschrijving: string; streefweken?: number }>;
      acties?: Array<{ beschrijving: string; doelIndex?: number; rolSuggestie?: string; termijnDagen?: number }>;
    }>(tekst, { samenvatting: 'Kon het AI-antwoord niet als JSON parsen - controleer handmatig.', aandachtspunten: [], confidence: 0.3, doelen: [], acties: [] });

    const volledigeSamenvatting = [parsed.samenvatting, (parsed.aandachtspunten || []).length ? 'Aandachtspunten:\n- ' + (parsed.aandachtspunten || []).join('\n- ') : ''].filter(Boolean).join('\n\n');
    const { error } = await supabase.from('opp_plans').update({ ai_summary: volledigeSamenvatting, ai_confidence: parsed.confidence ?? null, ai_data_used: gathered, ai_human_review_required: true }).eq('opp_id', oppId);
    if (error) throw error;

    let zorgcoordinatorId: string | null = null;
    const goalIds: string[] = [];
    for (const doel of parsed.doelen || []) {
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() + (doel.streefweken ?? 8) * 7);
      const { data: goal, error: goalError } = await supabase
        .from('opp_goals')
        .insert({ opp_id: oppId, description: doel.beschrijving, target_date: targetDate.toISOString().slice(0, 10), status: 'nieuw' })
        .select('goal_id')
        .single();
      if (goalError) throw goalError;
      goalIds.push(goal.goal_id);
    }
    for (const actie of parsed.acties || []) {
      const goalId = actie.doelIndex != null ? goalIds[actie.doelIndex] || null : null;
      let ownerId: string | null = null;
      if (actie.rolSuggestie === 'mentor') ownerId = student?.mentor_profile_id || null;
      else if (actie.rolSuggestie === 'zorgcoordinator') {
        if (zorgcoordinatorId === null) {
          const { data: zorg } = await supabase.from('profiles').select('id').eq('school_id', plan.school_id).eq('role', 'zorgcoordinator').limit(1).maybeSingle();
          zorgcoordinatorId = zorg?.id || '';
        }
        ownerId = zorgcoordinatorId || null;
      }
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + (actie.termijnDagen ?? 14));
      await supabase.from('opp_actions').insert({
        opp_id: oppId, goal_id: goalId, description: actie.beschrijving, owner_profile_id: ownerId,
        due_date: dueDate.toISOString().slice(0, 10), status: 'nieuw',
      });
    }

    return json({ ok: true, oppId, confidence: parsed.confidence ?? null, summary: volledigeSamenvatting, goalsCreated: goalIds.length, actionsCreated: (parsed.acties || []).length });
  } catch (err) {
    return json({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
