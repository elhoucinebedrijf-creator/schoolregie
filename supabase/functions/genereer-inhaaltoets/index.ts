// Edge function voor de vakdocent-UI (Fase 1): genereert een AI-concept
// inhaaltoets + antwoordmodel bij een gemiste toets. In tegenstelling tot
// de n8n-missed-tests/n8n-makeup-tests-generate-functies gebruikt dit
// endpoint GEWOON de sessie van de ingelogde gebruiker (standaard
// Supabase-JWT-verificatie, WEL gedeployed met verify-jwt) - RLS zorgt dat
// alleen staff binnen de eigen school iets kan opvragen/schrijven. De
// ANTHROPIC_API_KEY blijft hier server-side, precies zoals bij
// n8n-makeup-tests-generate.
import { createClient } from 'npm:@supabase/supabase-js@2.115.0';
import { corsHeaders, json, parseClaudeJson } from '../_shared/api.ts';

async function genereerInhaaltoets(input: { subject: string; level: string; learningObjectives: string; originalTestText: string }) {
  const system = `Je bent een ervaren toetsontwikkelaar in het Nederlandse voortgezet onderwijs. Je maakt een gelijkwaardige inhaaltoets (zelfde niveau en moeilijkheidsgraad als de originele toets, maar andere vraagstelling zodat een leerling hem niet uit het hoofd kan overnemen) plus een bijbehorend antwoordmodel. Dit concept wordt pas gebruikt na goedkeuring door de vakdocent.

Antwoord UITSLUITEND met geldige JSON, geen markdown-opmaak, in exact deze vorm:
{"vragen": "de volledige inhaaltoets als platte tekst", "antwoordmodel": "het volledige antwoordmodel als platte tekst", "confidence": 0.0 tot 1.0, "reden": "korte onderbouwing van je aanpak en confidence-score, in het Nederlands"}`;

  const user = `Vak: ${input.subject || 'onbekend'}
Niveau: ${input.level || 'onbekend'}
Leerdoelen: ${input.learningObjectives || 'niet opgegeven'}

Originele toets:
${input.originalTestText || '(geen originele toetstekst meegegeven - baseer de inhaaltoets dan uitsluitend op vak, niveau en leerdoelen, en verlaag de confidence-score.)'}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 4000, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`Claude-aanroep faalde: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const tekst = (data.content || []).map((c: { text?: string }) => c.text || '').join('\n');
  return parseClaudeJson(tekst, { vragen: tekst, antwoordmodel: '', confidence: 0.3, reden: 'Kon het AI-antwoord niet als JSON parsen - controleer handmatig.' });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Niet ingelogd.' }, 401);

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { missedTestId, subject, level, learningObjectives, originalTestText } = await req.json();
    if (!missedTestId) return json({ error: 'missedTestId is verplicht.' }, 400);

    // RLS zorgt dat dit alleen iets teruggeeft als de ingelogde gebruiker
    // staff is binnen de school van deze gemiste toets.
    const { data: missedTest } = await supabase
      .from('missed_tests')
      .select('missed_test_id, school_id, student_id, test_id')
      .eq('missed_test_id', missedTestId)
      .maybeSingle();
    if (!missedTest) return json({ error: 'Gemiste toets niet gevonden of geen toegang.' }, 404);

    const { data: makeupTest } = await supabase
      .from('makeup_tests')
      .select('makeup_test_id')
      .eq('missed_test_id', missedTestId)
      .maybeSingle();
    if (!makeupTest) return json({ error: 'Bijbehorende inhaalactie niet gevonden.' }, 404);

    const generated = await genereerInhaaltoets({ subject, level, learningObjectives, originalTestText });
    const dataUsed = { subject: subject || null, level: level || null, learningObjectives: learningObjectives || null, hadOriginalTestText: Boolean(originalTestText) };

    const { data: variantDoc, error: variantError } = await supabase
      .from('test_documents')
      .insert({
        school_id: missedTest.school_id,
        test_id: missedTest.test_id,
        missed_test_id: missedTest.missed_test_id,
        kind: 'ai_variant',
        content: generated.vragen || '',
        status: 'wacht_op_goedkeuring',
        ai_confidence: generated.confidence ?? null,
        ai_human_review_required: true,
        ai_reason: generated.reden || null,
        ai_data_used: dataUsed,
      })
      .select('document_id')
      .single();
    if (variantError) throw variantError;

    const { error: modelError } = await supabase.from('test_documents').insert({
      school_id: missedTest.school_id,
      test_id: missedTest.test_id,
      missed_test_id: missedTest.missed_test_id,
      kind: 'antwoordmodel',
      content: generated.antwoordmodel || '',
      status: 'wacht_op_goedkeuring',
      ai_confidence: generated.confidence ?? null,
      ai_human_review_required: true,
      ai_reason: generated.reden || null,
      ai_data_used: dataUsed,
    });
    if (modelError) throw modelError;

    const { error: updateError } = await supabase
      .from('makeup_tests')
      .update({ document_id: variantDoc.document_id, status: 'wacht_op_goedkeuring' })
      .eq('makeup_test_id', makeupTest.makeup_test_id);
    if (updateError) throw updateError;

    return json({ ok: true, makeupTestId: makeupTest.makeup_test_id, aiVariantDocumentId: variantDoc.document_id, confidence: generated.confidence ?? null, reason: generated.reden || null });
  } catch (err) {
    return json({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
