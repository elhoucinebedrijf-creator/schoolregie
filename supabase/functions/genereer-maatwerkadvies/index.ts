// Edge function voor de mentor/staff-UI (Fase 2): genereert een AI-
// maatwerkadvies bij een leerling op basis van cijfers. Zelfde logica als
// de interventions/advice-route in supabase/functions/api/index.ts, maar
// hier WEL met standaard Supabase-JWT-verificatie - geautoriseerd via de
// sessie van de ingelogde gebruiker + RLS i.p.v. het n8n-gedeelde geheim
// (zelfde patroon als genereer-inhaaltoets in Fase 1).
import { createClient } from 'npm:@supabase/supabase-js@2.115.0';
import { corsHeaders, json, parseClaudeJson } from '../_shared/api.ts';

async function genereerAdviesMetClaude(input: { studentName: string; period: string; grades: unknown; attendanceSummary: unknown }) {
  const system = `Je bent een ervaren mentor-adviseur in het Nederlandse voortgezet onderwijs. Op basis van cijfers (en eventueel verzuim) van een leerling beoordeel je per vak of maatwerkbegeleiding (bijles/extra oefening) nodig is. Dit is een ADVIES - een mentor bevestigt dit altijd voordat een leerling daadwerkelijk wordt ingepland.

Antwoord UITSLUITEND met geldige JSON, geen markdown-opmaak, in exact deze vorm:
{"adviezen": [{"vak": "vaknaam", "nodig": true of false, "reden": "...", "prioriteit": "laag" of "middel" of "hoog", "confidence": 0.0 tot 1.0}], "samenvatting": "korte samenvatting van het algehele beeld, in het Nederlands"}`;
  const user = `Leerling: ${input.studentName}\nPeriode: ${input.period || 'onbekend'}\nCijfers: ${JSON.stringify(input.grades)}\nVerzuimsamenvatting: ${input.attendanceSummary ? JSON.stringify(input.attendanceSummary) : 'niet meegegeven'}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 2000, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`Claude-aanroep faalde: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const tekst = (data.content || []).map((c: { text?: string }) => c.text || '').join('\n');
  return parseClaudeJson(tekst, { adviezen: [], samenvatting: 'Kon het AI-antwoord niet als JSON parsen - controleer handmatig.' });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Niet ingelogd.' }, 401);

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { studentId, period, grades, attendanceSummary } = await req.json();
    if (!studentId) return json({ error: 'studentId is verplicht.' }, 400);
    if (!Array.isArray(grades) || !grades.length) return json({ error: 'grades (niet-lege array) is verplicht.' }, 400);

    // RLS zorgt dat dit alleen iets teruggeeft als de ingelogde gebruiker
    // staff is binnen de school van deze leerling.
    const { data: student } = await supabase.from('students').select('student_id, school_id, full_name, mentor_profile_id').eq('student_id', studentId).maybeSingle();
    if (!student) return json({ error: 'Leerling niet gevonden of geen toegang.' }, 404);

    const parsed = await genereerAdviesMetClaude({ studentName: student.full_name, period, grades, attendanceSummary });

    const { data: subjects } = await supabase.from('subjects').select('subject_id, name').eq('school_id', student.school_id);
    const created = [];
    for (const advies of parsed.adviezen || []) {
      if (!advies.nodig) continue;
      const match = subjects?.find((s) => s.name.toLowerCase() === (advies.vak || '').toLowerCase());
      const { data: assignment, error } = await supabase
        .from('maatwerk_assignments')
        .insert({
          school_id: student.school_id, student_id: studentId, subject_id: match?.subject_id || null,
          status: 'nieuw', advice_reason: `[${advies.vak}] ${advies.reden}`, mentor_approved: false,
        })
        .select('assignment_id')
        .single();
      if (error) throw error;
      created.push({ assignmentId: assignment.assignment_id, vak: advies.vak, prioriteit: advies.prioriteit, confidence: advies.confidence });
    }

    return json({ ok: true, studentId, adviezen: parsed.adviezen || [], samenvatting: parsed.samenvatting || '', created });
  } catch (err) {
    return json({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
