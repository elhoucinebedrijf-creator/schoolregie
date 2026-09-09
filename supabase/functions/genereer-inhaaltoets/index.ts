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

async function genereerInhaaltoets(input: { subject: string; level: string; learningObjectives: string; originalTestText: string; feedback?: string }) {
  const system = `Je bent een ervaren toetsontwikkelaar in het Nederlandse voortgezet onderwijs. Je maakt een gelijkwaardige inhaaltoets (zelfde niveau en moeilijkheidsgraad als de originele toets, maar andere vraagstelling zodat een leerling hem niet uit het hoofd kan overnemen) plus een bijbehorend antwoordmodel. Dit concept wordt pas gebruikt na goedkeuring door de vakdocent.

WISKUNDETAAL (verplicht, ook bij andere vakken die rekenen/eenheden gebruiken): gebruik ALTIJD correcte wiskundige notatie met Unicode-tekens, nooit ASCII-benaderingen. Dus √25 (niet sqrt(25) of wortel(25)), x² en x³ (niet x^2), ½ en ¾ (niet 1/2 als dat als breuk bedoeld is, tenzij platte breuknotatie duidelijker is), π, ≤, ≥, ≠, ° voor graden. Bij een figuur, grafiek of tekening die je niet kunt tekenen: beschrijf die woordelijk en volledig genoeg dat een leerling zonder de afbeelding de vraag toch kan begrijpen (bijv. "Driehoek ABC met een rechte hoek bij B, AB = 6 cm, BC = 8 cm").

HULPMIDDELEN: geef ook aan wat de leerling nodig heeft en wat toegestaan is tijdens het inhaalmoment (bijv. rekenmachine, geodriehoek, BINAS, formulekaart) - dit is bedoeld voor de surveillant, niet voor de leerling vooraf.

Antwoord UITSLUITEND met geldige JSON, geen markdown-opmaak, in exact deze vorm:
{"vragen": "de volledige inhaaltoets als platte tekst, met correcte wiskundenotatie", "antwoordmodel": "het volledige antwoordmodel als platte tekst", "hulpmiddelen": "wat nodig/toegestaan is als hulpmiddel, of \\"geen\\" als er niets nodig is", "confidence": 0.0 tot 1.0, "reden": "korte onderbouwing van je aanpak en confidence-score, in het Nederlands"}`;

  const user = `Vak: ${input.subject || 'onbekend'}
Niveau: ${input.level || 'onbekend'}
Leerdoelen: ${input.learningObjectives || 'niet opgegeven'}

Originele toets:
${input.originalTestText || '(geen originele toetstekst meegegeven - baseer de inhaaltoets dan uitsluitend op vak, niveau en leerdoelen, en verlaag de confidence-score.)'}
${input.feedback ? `\nDe vakdocent heeft het vorige concept afgekeurd met deze aanwijzingen - verwerk dit expliciet in een nieuwe versie:\n${input.feedback}` : ''}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    // 8000 i.p.v. 4000 (Fase 9): de uitgebreide wiskundetaal/hulpmiddelen-
    // instructies maken het antwoord langer - bij 4000 liep de JSON soms
    // vast (afgekapt vóór de sluit-accolade), wat parseClaudeJson liet
    // terugvallen op de ruwe, onvolledige tekst.
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8000, system, messages: [{ role: 'user', content: user }] }),
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

    const { missedTestId, subject, level, learningObjectives, originalTestText, feedback } = await req.json();
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

    const generated = await genereerInhaaltoets({ subject, level, learningObjectives, originalTestText, feedback });
    const dataUsed = { subject: subject || null, level: level || null, learningObjectives: learningObjectives || null, hadOriginalTestText: Boolean(originalTestText), feedback: feedback || null };

    // Bij opnieuw genereren (na feedback) het vorige concept - dat nog op
    // "wacht_op_goedkeuring" staat - annuleren, zodat de toetsbank niet
    // vervuilt met verouderde varianten die niet meer gebruikt worden.
    if (feedback) {
      await supabase
        .from('test_documents')
        .update({ status: 'geannuleerd' })
        .eq('missed_test_id', missedTest.missed_test_id)
        .eq('status', 'wacht_op_goedkeuring')
        .in('kind', ['ai_variant', 'antwoordmodel']);
    }

    const { data: variantDoc, error: variantError } = await supabase
      .from('test_documents')
      .insert({
        school_id: missedTest.school_id,
        test_id: missedTest.test_id,
        missed_test_id: missedTest.missed_test_id,
        kind: 'ai_variant',
        content: generated.vragen || '',
        hulpmiddelen: generated.hulpmiddelen || null,
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

    // Taak-/meldingsketen voortzetten: de "genereer"-taak is klaar, er komt
    // een nieuwe "beoordeel"-taak voor in de plaats - zonder feedback (dus
    // een eerste generatie) is dit een nieuwe taak; bij "opnieuw genereren"
    // (met feedback) blijft de bestaande beoordeel-taak gewoon staan.
    if (!feedback) {
      await supabase
        .from('tasks')
        .update({ status: 'afgerond' })
        .eq('related_type', 'missed_test')
        .eq('related_id', missedTest.missed_test_id)
        .eq('status', 'nieuw');

      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await supabase.from('tasks').insert({
          school_id: missedTest.school_id,
          title: 'AI-concept beoordelen',
          description: `Er staat een AI-conceptinhaaltoets + antwoordmodel klaar (confidence: ${generated.confidence ?? 'onbekend'}). Beoordeel en keur goed of pas aan.`,
          owner_profile_id: user.id, related_student_id: missedTest.student_id, related_type: 'makeup_test', related_id: makeupTest.makeup_test_id, status: 'nieuw',
        });
      }
    }

    return json({ ok: true, makeupTestId: makeupTest.makeup_test_id, aiVariantDocumentId: variantDoc.document_id, confidence: generated.confidence ?? null, reason: generated.reden || null });
  } catch (err) {
    return json({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
