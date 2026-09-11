// Eén gedeployde edge function "api" die alle n8n-gerichte routes onder
// /api/n8n/* afhandelt. Nodig omdat Supabase edge functions op hun exacte
// naam routeren (elke functie = één top-level padsegment), terwijl de
// bestaande n8n-workflows consequent
// `$env.SCHOOLREGIE_API_BASE_URL + '/api/n8n/<route>'` aanroepen - dus
// alles onder /api/* moet door ÉÉN functie genaamd "api" afgehandeld
// worden, met interne routing op basis van het pad ná "/api/n8n/".
//
// Deployen: npx supabase functions deploy api --project-ref kuxagvhesctephrgfpfo --no-verify-jwt
import { createClient } from 'npm:@supabase/supabase-js@2.115.0';
import { corsHeaders, json, requireApiKey, parseClaudeJson } from '../_shared/api.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';

type Admin = ReturnType<typeof createClient>;

// === Fase 1: gemiste toetsen + AI-inhaaltoets ==================================

async function handleMissedTests(req: Request, admin: Admin) {
  const { studentId, testId, teacherId, mentorId, reason, source } = await req.json();
  if (!studentId || !testId || !teacherId) return json({ error: 'studentId, testId en teacherId zijn verplicht.' }, 400);

  const { data: student } = await admin
    .from('students')
    .select('student_id, school_id, full_name, mentor_profile_id')
    .eq('student_id', studentId)
    .maybeSingle();
  if (!student) return json({ error: 'Leerling niet gevonden.' }, 404);

  const { data: missedTest, error: missedError } = await admin
    .from('missed_tests')
    .insert({ school_id: student.school_id, student_id: studentId, test_id: testId, reason: reason || null, status: 'nieuw' })
    .select('missed_test_id')
    .single();
  if (missedError) throw missedError;

  const { data: makeupTest, error: makeupError } = await admin
    .from('makeup_tests')
    .insert({ school_id: student.school_id, missed_test_id: missedTest.missed_test_id, status: 'nieuw' })
    .select('makeup_test_id')
    .single();
  if (makeupError) throw makeupError;

  const staffBody = `${student.full_name} heeft een toets gemist (reden: ${reason || 'onbekend'}). Er is automatisch een inhaalactie aangemaakt.`;
  const ontvangers = [...new Set([teacherId, mentorId || student.mentor_profile_id].filter(Boolean))];
  for (const ontvangerId of ontvangers) {
    await notifyStaff(admin, { schoolId: student.school_id, profileId: ontvangerId as string, studentId, subject: `Gemiste toets: ${student.full_name}`, body: staffBody, templateKey: 'missed_test_notice' });
  }
  await notifyGuardiansAndStudent(admin, { schoolId: student.school_id, studentId, subject: `Gemiste toets: ${student.full_name}`, body: `${student.full_name} heeft een toets gemist. Zodra er een inhaalmoment is, hoor je dat automatisch.`, templateKey: 'missed_test_notice_family' });

  await admin.from('audit_logs').insert({
    school_id: student.school_id,
    action: 'missed_test_created',
    entity_type: 'missed_test',
    entity_id: missedTest.missed_test_id,
    detail: { source: source || 'n8n-webhook', testId, teacherId, mentorId: mentorId || student.mentor_profile_id },
  });

  return json({ ok: true, missedTestId: missedTest.missed_test_id, makeupTestId: makeupTest.makeup_test_id, studentId, status: 'nieuw' });
}

async function genereerInhaaltoetsMetClaude(input: { subject: string; level: string; learningObjectives: string; originalTestText: string; feedback?: string }) {
  const system = `Je bent een ervaren toetsontwikkelaar in het Nederlandse voortgezet onderwijs. Je maakt een gelijkwaardige inhaaltoets (zelfde niveau en moeilijkheidsgraad als de originele toets, maar andere vraagstelling zodat een leerling hem niet uit het hoofd kan overnemen) plus een bijbehorend antwoordmodel. Dit concept wordt pas gebruikt na goedkeuring door de vakdocent.

WISKUNDETAAL (verplicht, ook bij andere vakken die rekenen/eenheden gebruiken): gebruik ALTIJD correcte wiskundige notatie met Unicode-tekens, nooit ASCII-benaderingen. Dus √25 (niet sqrt(25) of wortel(25)), x² en x³ (niet x^2), ½ en ¾, π, ≤, ≥, ≠, ° voor graden. Bij een figuur, grafiek of tekening die je niet kunt tekenen: beschrijf die woordelijk en volledig genoeg dat een leerling zonder de afbeelding de vraag toch kan begrijpen.

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
    headers: { 'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    // 8000 i.p.v. 4000 (Fase 9) - zie toelichting bij dezelfde aanroep in
    // genereer-inhaaltoets/index.ts.
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8000, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`Claude-aanroep faalde: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const tekst = (data.content || []).map((c: { text?: string }) => c.text || '').join('\n');
  return parseClaudeJson(tekst, { vragen: tekst, antwoordmodel: '', confidence: 0.3, reden: 'Kon het AI-antwoord niet als JSON parsen - controleer handmatig.' });
}

async function handleMakeupTestsGenerate(req: Request, admin: Admin) {
  const { missedTestId, subject, level, learningObjectives, originalTestText, teacherId } = await req.json();
  if (!missedTestId) return json({ error: 'missedTestId is verplicht.' }, 400);

  const { data: missedTest } = await admin
    .from('missed_tests')
    .select('missed_test_id, school_id, student_id, test_id')
    .eq('missed_test_id', missedTestId)
    .maybeSingle();
  if (!missedTest) return json({ error: 'Gemiste toets niet gevonden.' }, 404);

  const { data: makeupTest } = await admin.from('makeup_tests').select('makeup_test_id').eq('missed_test_id', missedTestId).maybeSingle();
  if (!makeupTest) return json({ error: 'Bijbehorende inhaalactie niet gevonden.' }, 404);

  const generated = await genereerInhaaltoetsMetClaude({ subject, level, learningObjectives, originalTestText });
  const dataUsed = { subject: subject || null, level: level || null, learningObjectives: learningObjectives || null, hadOriginalTestText: Boolean(originalTestText) };

  const { data: variantDoc, error: variantError } = await admin
    .from('test_documents')
    .insert({
      school_id: missedTest.school_id, test_id: missedTest.test_id, missed_test_id: missedTest.missed_test_id,
      kind: 'ai_variant', content: generated.vragen || '', hulpmiddelen: generated.hulpmiddelen || null, status: 'wacht_op_goedkeuring',
      ai_confidence: generated.confidence ?? null, ai_human_review_required: true, ai_reason: generated.reden || null, ai_data_used: dataUsed,
    })
    .select('document_id')
    .single();
  if (variantError) throw variantError;

  const { error: modelError } = await admin.from('test_documents').insert({
    school_id: missedTest.school_id, test_id: missedTest.test_id, missed_test_id: missedTest.missed_test_id,
    kind: 'antwoordmodel', content: generated.antwoordmodel || '', status: 'wacht_op_goedkeuring',
    ai_confidence: generated.confidence ?? null, ai_human_review_required: true, ai_reason: generated.reden || null, ai_data_used: dataUsed,
  });
  if (modelError) throw modelError;

  const { error: updateError } = await admin
    .from('makeup_tests')
    .update({ document_id: variantDoc.document_id, status: 'wacht_op_goedkeuring' })
    .eq('makeup_test_id', makeupTest.makeup_test_id);
  if (updateError) throw updateError;

  await admin.from('audit_logs').insert({
    school_id: missedTest.school_id, action: 'makeup_test_ai_generated', entity_type: 'makeup_test', entity_id: makeupTest.makeup_test_id,
    detail: { confidence: generated.confidence ?? null, teacherId: teacherId || null },
  });

  return json({
    ok: true, makeupTestId: makeupTest.makeup_test_id, missedTestId, studentId: missedTest.student_id, teacherId: teacherId || null,
    aiVariantDocumentId: variantDoc.document_id, confidence: generated.confidence ?? null, reason: generated.reden || null, status: 'wacht_op_goedkeuring',
  });
}

async function handleTasksTeacherReview(req: Request, admin: Admin) {
  const { makeupTest, action } = await req.json();
  const makeupTestId = makeupTest?.makeupTestId;
  if (!makeupTestId) return json({ error: 'makeupTest.makeupTestId is verplicht.' }, 400);

  const { data: makeup } = await admin
    .from('makeup_tests')
    .select('makeup_test_id, school_id, missed_test_id, missed_tests(student_id, students(full_name))')
    .eq('makeup_test_id', makeupTestId)
    .maybeSingle();
  if (!makeup) return json({ error: 'Inhaalactie niet gevonden.' }, 404);

  const studentId = makeupTest.studentId || makeup.missed_tests?.student_id || null;
  const studentName = makeup.missed_tests?.students?.full_name || 'de leerling';
  const teacherId = makeupTest.teacherId || null;
  if (!teacherId) return json({ error: 'makeupTest.teacherId is verplicht om de taak toe te wijzen.' }, 400);

  const { data: task, error: taskError } = await admin
    .from('tasks')
    .insert({
      school_id: makeup.school_id,
      title: `AI-inhaaltoets beoordelen voor ${studentName}`,
      description: `Er is een AI-conceptinhaaltoets + antwoordmodel klaargezet (confidence: ${makeupTest.confidence ?? 'onbekend'}). Reden AI: ${makeupTest.reason || 'geen toelichting'}. Beoordeel en keur goed of pas aan voordat de toets ingezet wordt.`,
      owner_profile_id: teacherId, related_student_id: studentId, related_type: 'makeup_test', related_id: makeupTestId, status: 'nieuw',
    })
    .select('task_id')
    .single();
  if (taskError) throw taskError;

  await notifyStaff(admin, {
    schoolId: makeup.school_id, profileId: teacherId, studentId,
    subject: `AI-inhaaltoets klaar voor beoordeling: ${studentName}`,
    body: `Er staat een AI-conceptinhaaltoets + antwoordmodel klaar voor ${studentName} (confidence: ${makeupTest.confidence ?? 'onbekend'}). Beoordeel en keur goed of pas aan voordat de toets ingezet wordt.`,
    templateKey: 'ai_makeup_test_ready',
  });

  await admin.from('audit_logs').insert({
    school_id: makeup.school_id, action: 'teacher_review_task_created', entity_type: 'makeup_test', entity_id: makeupTestId,
    detail: { taskId: task.task_id, action: action || 'teacher_approval_required', teacherId },
  });

  return json({ ok: true, taskId: task.task_id, makeupTestId, teacherId, status: 'wacht_op_goedkeuring' });
}

// === Fase 2: verzuim + maatwerk =================================================

// Herinner-cadans (Fase 10): eerste herinnering na 2 dagen, daarna elke 3
// dagen zolang iets openstaat - voorkomt zowel een mailbox die dagelijks
// dezelfde melding herhaalt als dingen die stil blijven liggen.
function shouldRemind(createdAt: string, lastRemindedAt: string | null): boolean {
  const now = Date.now();
  const dag = 24 * 60 * 60 * 1000;
  if (!lastRemindedAt) return now - new Date(createdAt).getTime() >= 2 * dag;
  return now - new Date(lastRemindedAt).getTime() >= 3 * dag;
}

async function handleActionsDue(admin: Admin) {
  const today = new Date().toISOString().slice(0, 10);
  const [{ data: tasks }, { data: interventions }, { data: conversations }, { data: oppSignatures }] = await Promise.all([
    admin.from('tasks').select('task_id, school_id, title, owner_profile_id, related_student_id, due_date, status, created_at, last_reminded_at').in('status', ['nieuw', 'in_behandeling']),
    admin.from('interventions').select('intervention_id, school_id, student_id, kind, owner_profile_id, due_date, status, created_at, last_reminded_at'),
    admin.from('conversations').select('conversation_id, school_id, student_id, scheduled_at, confirmed_by_guardian, status, created_at, last_reminded_at').eq('status', 'gepland'),
    admin.from('opp_signatures').select('signature_id, school_id, opp_id, guardian_id, signer_profile_id, status, created_at, last_reminded_at, opp_plans(student_id)').eq('status', 'nieuw'),
  ]);

  const actions = [];
  for (const t of tasks || []) {
    if (!shouldRemind(t.created_at, t.last_reminded_at)) continue;
    const overdue = Boolean(t.due_date && t.due_date < today);
    actions.push({ type: 'task', id: t.task_id, schoolId: t.school_id, title: t.title, ownerProfileId: t.owner_profile_id, studentId: t.related_student_id, dueDate: t.due_date, overdue, priority: overdue ? 'hoog' : 'normaal' });
  }
  for (const i of interventions || []) {
    if (i.status === 'afgerond' || i.status === 'geannuleerd') continue;
    if (!shouldRemind(i.created_at, i.last_reminded_at)) continue;
    const overdue = Boolean(i.due_date && i.due_date < today);
    actions.push({ type: 'intervention', id: i.intervention_id, schoolId: i.school_id, title: `Interventie (${i.kind})`, ownerProfileId: i.owner_profile_id, studentId: i.student_id, dueDate: i.due_date, overdue, priority: overdue ? 'hoog' : 'normaal' });
  }
  for (const c of conversations || []) {
    if (c.confirmed_by_guardian) continue;
    if (!shouldRemind(c.created_at, c.last_reminded_at)) continue;
    actions.push({ type: 'conversation', id: c.conversation_id, schoolId: c.school_id, title: 'Oudergesprek nog niet bevestigd', studentId: c.student_id, dueDate: c.scheduled_at ? c.scheduled_at.slice(0, 10) : null, overdue: false, priority: 'normaal' });
  }
  for (const s of oppSignatures || []) {
    if (!shouldRemind(s.created_at, s.last_reminded_at)) continue;
    actions.push({ type: 'opp_signature', id: s.signature_id, schoolId: s.school_id, title: 'OPP nog niet ondertekend', guardianId: s.guardian_id, signerProfileId: s.signer_profile_id, studentId: s.opp_plans?.student_id || null, dueDate: null, overdue: false, priority: 'normaal' });
  }

  return json({ ok: true, actions, count: actions.length });
}

async function handleActionsSendReminders(req: Request, admin: Admin) {
  const { actions } = await req.json();
  let verstuurd = 0;
  const now = new Date().toISOString();
  for (const a of actions || []) {
    if (!a.schoolId) continue;
    const subject = `Herinnering: ${a.title}${a.overdue ? ' (te laat)' : ''}`;
    const body = `${a.title}${a.dueDate ? ` - deadline: ${a.dueDate}` : ''}.`;

    if (a.type === 'task' || a.type === 'intervention') {
      if (!a.ownerProfileId) continue;
      const { error } = await admin.from('communications').insert({
        school_id: a.schoolId, student_id: a.studentId || null, recipient_profile_id: a.ownerProfileId,
        channel: 'email', template_key: 'open_action_reminder', subject, body, status: 'nieuw',
      });
      if (error) continue;
      await admin.from(a.type === 'task' ? 'tasks' : 'interventions').update({ last_reminded_at: now }).eq(a.type === 'task' ? 'task_id' : 'intervention_id', a.id);
      verstuurd++;
    } else if (a.type === 'conversation') {
      const { data: guardianLinks } = await admin.from('student_guardians').select('guardian_id').eq('student_id', a.studentId);
      let sent = false;
      for (const g of guardianLinks || []) {
        const { error } = await admin.from('communications').insert({
          school_id: a.schoolId, student_id: a.studentId, guardian_id: g.guardian_id,
          channel: 'email', template_key: 'conversation_reminder', subject, body: `${body} Bevestig het voorgestelde moment.`, status: 'nieuw',
        });
        if (!error) sent = true;
      }
      if (sent) { await admin.from('conversations').update({ last_reminded_at: now }).eq('conversation_id', a.id); verstuurd++; }
    } else if (a.type === 'opp_signature') {
      if (!a.guardianId && !a.signerProfileId) continue;
      const { error } = await admin.from('communications').insert({
        school_id: a.schoolId, student_id: a.studentId, guardian_id: a.guardianId || null, recipient_profile_id: a.signerProfileId || null,
        channel: 'email', template_key: 'opp_signature_reminder', subject, body: `${body} Geef akkoord of laat weten dat je nog vragen hebt.`, status: 'nieuw',
      });
      if (error) continue;
      await admin.from('opp_signatures').update({ last_reminded_at: now }).eq('signature_id', a.id);
      verstuurd++;
    }
  }
  return json({ ok: true, remindersSent: verstuurd, totalActions: (actions || []).length });
}

async function handleAttendanceSignals(req: Request, admin: Admin) {
  const { studentId, eventType, eventDate, lessonPeriod, explanation, proposedAction } = await req.json();
  if (!studentId) return json({ error: 'studentId is verplicht.' }, 400);
  const type = eventType || 'ongeoorloofd_afwezig';
  if (!['te_laat', 'ongeoorloofd_afwezig', 'spijbelen', 'geoorloofd_afwezig'].includes(type)) {
    return json({ error: `Onbekend eventType: ${type}` }, 400);
  }

  const { data: student } = await admin.from('students').select('student_id, school_id, full_name, mentor_profile_id').eq('student_id', studentId).maybeSingle();
  if (!student) return json({ error: 'Leerling niet gevonden.' }, 404);

  const { data: event, error: eventError } = await admin
    .from('attendance_events')
    .insert({ school_id: student.school_id, student_id: studentId, event_type: type, event_date: (eventDate || new Date().toISOString()).slice(0, 10), note: [lessonPeriod ? `Lesuur: ${lessonPeriod}` : null, explanation || null].filter(Boolean).join(' - ') || null })
    .select('event_id')
    .single();
  if (eventError) throw eventError;

  if (type === 'geoorloofd_afwezig') {
    return json({ ok: true, eventId: event.event_id, thresholdReached: false });
  }

  const { data: settings } = await admin.from('school_settings').select('*').eq('school_id', student.school_id).maybeSingle();
  const thresholds: Record<string, number> = {
    te_laat: settings?.attendance_late_threshold ?? 3,
    ongeoorloofd_afwezig: settings?.attendance_unauthorized_threshold ?? 3,
    spijbelen: settings?.attendance_truancy_threshold ?? 1,
  };
  const threshold = thresholds[type];

  const sinds = new Date();
  sinds.setDate(sinds.getDate() - 60);
  const { data: recentEvents } = await admin
    .from('attendance_events')
    .select('event_id')
    .eq('student_id', studentId)
    .eq('event_type', type)
    .gte('event_date', sinds.toISOString().slice(0, 10));
  const aantal = recentEvents?.length || 0;
  const thresholdReached = aantal >= threshold;

  let actie: Record<string, unknown> | null = null;
  if (thresholdReached) {
    if (type === 'spijbelen') {
      const { data: signal } = await admin
        .from('signals')
        .insert({ school_id: student.school_id, student_id: studentId, level: 'hoog', trigger_type: 'verzuim_spijbelen', detail: `${aantal}x spijbelen binnen 60 dagen (drempel: ${threshold}). Voorgestelde actie: ${proposedAction || 'onbekend'}.`, status: 'nieuw' })
        .select('signal_id')
        .single();
      actie = { type: 'signal', id: signal?.signal_id };
    } else {
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + 3);
      const { data: intervention } = await admin
        .from('interventions')
        .insert({ school_id: student.school_id, student_id: studentId, kind: 'verzuim_opvolging', owner_profile_id: student.mentor_profile_id, due_date: dueDate.toISOString().slice(0, 10), status: 'nieuw', notes: `${aantal}x ${type} binnen 60 dagen (drempel: ${threshold}).` })
        .select('intervention_id')
        .single();
      actie = { type: 'intervention', id: intervention?.intervention_id };
    }
    const drempelBody = `${student.full_name} heeft de drempel voor "${type}" bereikt (${aantal}x binnen 60 dagen, drempel: ${threshold}).`;
    if (student.mentor_profile_id) {
      await notifyStaff(admin, { schoolId: student.school_id, profileId: student.mentor_profile_id, studentId, subject: `Verzuimdrempel bereikt: ${student.full_name}`, body: drempelBody, templateKey: 'attendance_threshold_reached' });
    }
    await notifyGuardiansAndStudent(admin, { schoolId: student.school_id, studentId, subject: `Verzuimdrempel bereikt: ${student.full_name}`, body: drempelBody, templateKey: 'attendance_threshold_reached_family' });
  }

  await admin.from('audit_logs').insert({
    school_id: student.school_id, action: 'attendance_event_registered', entity_type: 'attendance_event', entity_id: event.event_id,
    detail: { eventType: type, thresholdReached, count: aantal, threshold },
  });

  return json({ ok: true, eventId: event.event_id, thresholdReached, count: aantal, threshold, action: actie });
}

async function handleInterventionsAdvice(req: Request, admin: Admin) {
  const { studentId, period, grades, attendanceSummary } = await req.json();
  if (!studentId) return json({ error: 'studentId is verplicht (klasbreed adviseren zonder leerling is nog niet ondersteund).' }, 400);
  if (!Array.isArray(grades) || !grades.length) return json({ error: 'grades (niet-lege array) is verplicht.' }, 400);

  const { data: student } = await admin.from('students').select('student_id, school_id, full_name, mentor_profile_id').eq('student_id', studentId).maybeSingle();
  if (!student) return json({ error: 'Leerling niet gevonden.' }, 404);

  const system = `Je bent een ervaren mentor-adviseur in het Nederlandse voortgezet onderwijs. Op basis van cijfers (en eventueel verzuim) van een leerling beoordeel je per vak of maatwerkbegeleiding (bijles/extra oefening) nodig is. Dit is een ADVIES - een mentor bevestigt dit altijd voordat een leerling daadwerkelijk wordt ingepland.

Antwoord UITSLUITEND met geldige JSON, geen markdown-opmaak, in exact deze vorm:
{"adviezen": [{"vak": "vaknaam", "nodig": true of false, "reden": "...", "prioriteit": "laag" of "middel" of "hoog", "confidence": 0.0 tot 1.0}], "samenvatting": "korte samenvatting van het algehele beeld, in het Nederlands"}`;
  const user = `Leerling: ${student.full_name}\nPeriode: ${period || 'onbekend'}\nCijfers: ${JSON.stringify(grades)}\nVerzuimsamenvatting: ${attendanceSummary ? JSON.stringify(attendanceSummary) : 'niet meegegeven'}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 2000, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`Claude-aanroep faalde: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const tekst = (data.content || []).map((c: { text?: string }) => c.text || '').join('\n');
  const parsed = parseClaudeJson<{ adviezen?: Array<{ vak: string; nodig: boolean; reden: string; prioriteit: string; confidence: number }>; samenvatting?: string }>(
    tekst,
    { adviezen: [], samenvatting: 'Kon het AI-antwoord niet als JSON parsen - controleer handmatig.' },
  );

  const { data: subjects } = await admin.from('subjects').select('subject_id, name').eq('school_id', student.school_id);
  const created = [];
  for (const advies of parsed.adviezen || []) {
    if (!advies.nodig) continue;
    const match = subjects?.find((s) => s.name.toLowerCase() === (advies.vak || '').toLowerCase());
    const { data: assignment, error } = await admin
      .from('maatwerk_assignments')
      .insert({
        school_id: student.school_id, student_id: studentId, subject_id: match?.subject_id || null,
        status: 'nieuw', advice_reason: `[${advies.vak}] ${advies.reden}`, mentor_approved: false,
      })
      .select('assignment_id')
      .single();
    if (!error) created.push({ assignmentId: assignment.assignment_id, vak: advies.vak, prioriteit: advies.prioriteit, confidence: advies.confidence });
  }

  if (created.length && student.mentor_profile_id) {
    await admin.from('tasks').insert({
      school_id: student.school_id, title: `Maatwerkadvies beoordelen voor ${student.full_name}`,
      description: `AI-advies: ${parsed.samenvatting || ''}`, owner_profile_id: student.mentor_profile_id,
      related_student_id: studentId, related_type: 'maatwerk_assignment', status: 'nieuw',
    });
  }

  await admin.from('audit_logs').insert({
    school_id: student.school_id, action: 'maatwerk_advice_generated', entity_type: 'student', entity_id: studentId,
    detail: { adviesCount: parsed.adviezen?.length || 0, createdCount: created.length },
  });

  return json({ ok: true, studentId, adviezen: parsed.adviezen || [], samenvatting: parsed.samenvatting || '', created });
}

// === Fase 3: signalen/escalatie + oudergesprekken + communicatie ===============

const SIGNAL_LEVELS = ['laag', 'middel', 'hoog', 'kritiek'];

async function handleSignalsMajor(req: Request, admin: Admin) {
  const { studentId, mentorId, teamLeaderId, severity, category, explanation, suggestedAction } = await req.json();
  if (!studentId) return json({ error: 'studentId is verplicht.' }, 400);
  const level = SIGNAL_LEVELS.includes(severity) ? severity : 'hoog';

  const { data: student } = await admin.from('students').select('student_id, school_id, full_name, mentor_profile_id').eq('student_id', studentId).maybeSingle();
  if (!student) return json({ error: 'Leerling niet gevonden.' }, 404);

  const { data: signal, error: signalError } = await admin
    .from('signals')
    .insert({ school_id: student.school_id, student_id: studentId, level, trigger_type: category || 'combinatie_verzuim_resultaten', detail: explanation || null, status: 'nieuw' })
    .select('signal_id')
    .single();
  if (signalError) throw signalError;

  const signaalBody = `${explanation || 'Groot signaal gedetecteerd.'} Voorgestelde actie: ${suggestedAction || 'oudergesprek_en_bijsturing'}.`;
  const ownerId = mentorId || student.mentor_profile_id;
  if (ownerId) {
    await admin.from('tasks').insert({
      school_id: student.school_id, title: `Groot signaal: bespreek ${student.full_name}`,
      description: signaalBody,
      owner_profile_id: ownerId, related_student_id: studentId, related_type: 'signal', related_id: signal.signal_id, status: 'nieuw',
    });
    await notifyStaff(admin, { schoolId: student.school_id, profileId: ownerId, studentId, subject: `Groot signaal: ${student.full_name}`, body: signaalBody, templateKey: 'signal_mentor_notice' });
  }
  if (teamLeaderId) {
    await notifyStaff(admin, { schoolId: student.school_id, profileId: teamLeaderId, studentId, subject: `Groot signaal: ${student.full_name}`, body: signaalBody, templateKey: 'signal_teamleider_notice' });
  }
  await admin.from('dossier_entries').insert({
    school_id: student.school_id, student_id: studentId, entry_type: 'signaal', related_type: 'signal', related_id: signal.signal_id,
    summary: `[${level}] ${category || 'combinatie_verzuim_resultaten'}: ${explanation || 'Groot signaal gedetecteerd.'}`,
  });

  await admin.from('audit_logs').insert({
    school_id: student.school_id, action: 'major_signal_created', entity_type: 'signal', entity_id: signal.signal_id, detail: { level, category },
  });

  return json({ ok: true, signalId: signal.signal_id, studentId, level, mentorId: ownerId || null });
}

async function handleMeetingsParentConversationPropose(req: Request, admin: Admin) {
  const { signal } = await req.json();
  const studentId = signal?.studentId;
  if (!studentId) return json({ error: 'signal.studentId is verplicht.' }, 400);

  const { data: student } = await admin.from('students').select('student_id, school_id, full_name').eq('student_id', studentId).maybeSingle();
  if (!student) return json({ error: 'Leerling niet gevonden.' }, 404);

  const { data: conversation, error } = await admin
    .from('conversations')
    .insert({ school_id: student.school_id, student_id: studentId, kind: 'oudergesprek', proposed_by: signal.mentorId || null, status: 'nieuw' })
    .select('conversation_id')
    .single();
  if (error) throw error;

  const gesprekBody = `Naar aanleiding van recente signalen willen we graag een gesprek plannen over ${student.full_name}. De mentor neemt hierover contact op.`;
  if (signal.mentorId) {
    await admin.from('tasks').insert({
      school_id: student.school_id, title: `Oudergesprek inplannen: ${student.full_name}`,
      description: 'Plan een datum/tijd in en informeer de ouder(s).', owner_profile_id: signal.mentorId,
      related_student_id: studentId, related_type: 'conversation', related_id: conversation.conversation_id, status: 'nieuw',
    });
    await notifyStaff(admin, { schoolId: student.school_id, profileId: signal.mentorId, studentId, subject: `Oudergesprek voorgesteld: ${student.full_name}`, body: 'Plan een datum/tijd in en informeer de ouder(s).', templateKey: 'parent_conversation_proposed_mentor' });
  }
  await notifyGuardiansAndStudent(admin, { schoolId: student.school_id, studentId, subject: `Verzoek om een gesprek: ${student.full_name}`, body: gesprekBody, templateKey: 'parent_conversation_proposed' });

  return json({ ok: true, conversationId: conversation.conversation_id, studentId, status: 'nieuw' });
}

async function handleCommunicationsPrepare(req: Request, admin: Admin) {
  const { studentId, eventType, channels, recipients, subject, messageTemplate, data, requiresApproval } = await req.json();
  if (!studentId) return json({ error: 'studentId is verplicht.' }, 400);

  const { data: student } = await admin.from('students').select('student_id, school_id, full_name').eq('student_id', studentId).maybeSingle();
  if (!student) return json({ error: 'Leerling niet gevonden.' }, 404);

  const { data: guardianLinks } = await admin.from('student_guardians').select('guardian_id').eq('student_id', studentId);
  const guardianId = guardianLinks?.[0]?.guardian_id || null;

  const kanalen: string[] = Array.isArray(channels) && channels.length ? channels : ['email'];
  const ontvangers: string[] = Array.isArray(recipients) && recipients.length ? recipients : ['leerling', 'ouder', 'mentor'];
  const status = requiresApproval === false ? 'nieuw' : 'wacht_op_goedkeuring';
  const bodyTekst = data && Object.keys(data).length ? Object.entries(data).map(([k, v]) => `${k}: ${v}`).join('\n') : `Melding: ${eventType || 'algemene_melding'}.`;

  const created = [];
  for (const ontvanger of ontvangers) {
    for (const kanaal of kanalen) {
      const { data: comm, error } = await admin
        .from('communications')
        .insert({
          school_id: student.school_id, student_id: studentId, guardian_id: ontvanger === 'ouder' ? guardianId : null,
          channel: kanaal, template_key: messageTemplate || eventType || 'algemene_melding',
          subject: subject || `Bericht over ${student.full_name}`, body: bodyTekst, status,
        })
        .select('communication_id')
        .single();
      if (!error) created.push(comm.communication_id);
    }
  }

  return json({ ok: true, studentId, communicationIds: created, count: created.length, status });
}

// === Fase 4: OPP/zorg + zorgoverleg/MDO =========================================

async function callClaude(system: string, user: string, maxTokens = 2000) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`Claude-aanroep faalde: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.content || []).map((c: { text?: string }) => c.text || '').join('\n');
}

async function handleOppStart(req: Request, admin: Admin) {
  const { studentId, mentorId, careCoordinatorId, reason } = await req.json();
  if (!studentId) return json({ error: 'studentId is verplicht.' }, 400);

  const { data: student } = await admin.from('students').select('student_id, school_id, full_name, mentor_profile_id').eq('student_id', studentId).maybeSingle();
  if (!student) return json({ error: 'Leerling niet gevonden.' }, 404);

  let ownerId = careCoordinatorId;
  if (!ownerId) {
    const { data: zorg } = await admin.from('profiles').select('id').eq('school_id', student.school_id).eq('role', 'zorgcoordinator').limit(1).maybeSingle();
    ownerId = zorg?.id || null;
  }

  const reviewDueDate = new Date();
  reviewDueDate.setDate(reviewDueDate.getDate() + 42); // 6 weken - geen exacte cadans in de spec gegeven, redelijke standaard
  const { data: opp, error } = await admin
    .from('opp_plans')
    .insert({ school_id: student.school_id, student_id: studentId, status: 'nieuw', ai_human_review_required: true, started_by: null, review_due_date: reviewDueDate.toISOString().slice(0, 10) })
    .select('opp_id')
    .single();
  if (error) throw error;

  if (ownerId) {
    await admin.from('tasks').insert({
      school_id: student.school_id, title: `OPP-traject beoordelen: ${student.full_name}`,
      description: reason || 'Structurele signalen vragen om OPP-voorbereiding.', owner_profile_id: ownerId,
      related_student_id: studentId, related_type: 'opp_plan', related_id: opp.opp_id, status: 'nieuw',
    });
    await notifyStaff(admin, { schoolId: student.school_id, profileId: ownerId, studentId, subject: `OPP-traject gestart: ${student.full_name}`, body: reason || 'Structurele signalen vragen om OPP-voorbereiding.', templateKey: 'opp_start' });
  }
  await admin.from('dossier_entries').insert({
    school_id: student.school_id, student_id: studentId, entry_type: 'opp_start', related_type: 'opp_plan', related_id: opp.opp_id,
    summary: reason || 'OPP-traject gestart als concept, wacht op zorgcoördinator.',
  });

  return json({ ok: true, oppId: opp.opp_id, studentId, mentorId: mentorId || student.mentor_profile_id || null, careCoordinatorId: ownerId, status: 'nieuw' });
}

async function handleOppPrepareSummary(req: Request, admin: Admin) {
  const { opp, include } = await req.json();
  const oppId = opp?.oppId;
  if (!oppId) return json({ error: 'opp.oppId is verplicht.' }, 400);

  const { data: plan } = await admin.from('opp_plans').select('opp_id, school_id, student_id').eq('opp_id', oppId).maybeSingle();
  if (!plan) return json({ error: 'OPP-traject niet gevonden.' }, 404);
  const { data: student } = await admin.from('students').select('full_name, mentor_profile_id').eq('student_id', plan.student_id).maybeSingle();

  const categories: string[] = Array.isArray(include) && include.length ? include : ['results', 'attendance', 'interventions', 'signals', 'dossier'];
  const gathered: Record<string, unknown> = {};
  if (categories.includes('results')) {
    const [{ data: missed }, { data: maatwerk }] = await Promise.all([
      admin.from('missed_tests').select('reason, status, created_at').eq('student_id', plan.student_id),
      admin.from('maatwerk_assignments').select('advice_reason, status, created_at').eq('student_id', plan.student_id),
    ]);
    gathered.results = { missedTests: missed || [], maatwerkAssignments: maatwerk || [] };
  }
  if (categories.includes('attendance')) {
    const { data: events } = await admin.from('attendance_events').select('event_type, event_date').eq('student_id', plan.student_id).order('event_date', { ascending: false }).limit(30);
    gathered.attendance = events || [];
  }
  if (categories.includes('interventions')) {
    const { data: interventions } = await admin.from('interventions').select('kind, status, due_date, notes').eq('student_id', plan.student_id);
    gathered.interventions = interventions || [];
  }
  if (categories.includes('signals')) {
    const { data: signals } = await admin.from('signals').select('level, trigger_type, detail, status, created_at').eq('student_id', plan.student_id);
    gathered.signals = signals || [];
  }
  if (categories.includes('dossier')) {
    const { data: dossier } = await admin.from('dossier_entries').select('entry_type, summary, created_at').eq('student_id', plan.student_id).order('created_at', { ascending: false }).limit(20);
    gathered.dossier = dossier || [];
  }

  const system = `Je bent een ervaren zorgcoördinator-adviseur in het Nederlandse voortgezet onderwijs. Op basis van de aangeleverde gegevens (resultaten/inhaalacties, verzuim, interventies, signalen, dossier) maak je een NEUTRALE, feitelijke concept-samenvatting ter voorbereiding van een OPP-traject (ontwikkelingsperspectiefplan), plus een concreet CONCEPT-voorstel voor doelen en acties zodat de zorgcoördinator alleen nog hoeft te beoordelen/goedkeuren i.p.v. het OPP zelf te moeten opstellen. Dit blijft een concept - jij neemt NOOIT het besluit of een OPP daadwerkelijk gestart of goedgekeurd wordt; dat doet altijd een zorgcoördinator.

Antwoord UITSLUITEND met geldige JSON, geen markdown-opmaak:
{"samenvatting": "neutrale feitelijke samenvatting, 150-250 woorden, in het Nederlands", "aandachtspunten": ["puntsgewijze aandachtspunten"], "confidence": 0.0 tot 1.0, "doelen": [{"beschrijving": "concreet, haalbaar doel", "streefweken": 8}], "acties": [{"beschrijving": "concrete actie die dit doel dichterbij brengt", "doelIndex": 0, "rolSuggestie": "mentor of zorgcoordinator", "termijnDagen": 14}]}
Geef 2 tot 5 doelen en per doel 1-3 acties.`;
  const user = `Leerling: ${student?.full_name || 'onbekend'}\nGegevens: ${JSON.stringify(gathered)}`;
  const tekst = await callClaude(system, user, 3000);
  const parsed = parseClaudeJson<{
    samenvatting?: string; aandachtspunten?: string[]; confidence?: number;
    doelen?: Array<{ beschrijving: string; streefweken?: number }>;
    acties?: Array<{ beschrijving: string; doelIndex?: number; rolSuggestie?: string; termijnDagen?: number }>;
  }>(tekst, { samenvatting: 'Kon het AI-antwoord niet als JSON parsen - controleer handmatig.', aandachtspunten: [], confidence: 0.3, doelen: [], acties: [] });

  const volledigeSamenvatting = [parsed.samenvatting, (parsed.aandachtspunten || []).length ? 'Aandachtspunten:\n- ' + (parsed.aandachtspunten || []).join('\n- ') : ''].filter(Boolean).join('\n\n');
  const { error } = await admin.from('opp_plans').update({ ai_summary: volledigeSamenvatting, ai_confidence: parsed.confidence ?? null, ai_data_used: gathered, ai_human_review_required: true }).eq('opp_id', oppId);
  if (error) throw error;

  let zorgcoordinatorId: string | null = null;
  const goalIds: string[] = [];
  for (const doel of parsed.doelen || []) {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + (doel.streefweken ?? 8) * 7);
    const { data: goal, error: goalError } = await admin
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
        const { data: zorg } = await admin.from('profiles').select('id').eq('school_id', plan.school_id).eq('role', 'zorgcoordinator').limit(1).maybeSingle();
        zorgcoordinatorId = zorg?.id || '';
      }
      ownerId = zorgcoordinatorId || null;
    }
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + (actie.termijnDagen ?? 14));
    await admin.from('opp_actions').insert({
      opp_id: oppId, goal_id: goalId, description: actie.beschrijving, owner_profile_id: ownerId,
      due_date: dueDate.toISOString().slice(0, 10), status: 'nieuw',
    });
  }

  return json({ ok: true, oppId, confidence: parsed.confidence ?? null, summary: volledigeSamenvatting, goalsCreated: goalIds.length, actionsCreated: (parsed.acties || []).length });
}

async function handleOppDueReviews(admin: Admin) {
  const today = new Date().toISOString().slice(0, 10);
  const inZevenDagen = new Date();
  inZevenDagen.setDate(inZevenDagen.getDate() + 7);
  const { data: plans } = await admin
    .from('opp_plans')
    .select('opp_id, school_id, student_id, status, review_due_date, students(full_name, mentor_profile_id)')
    .not('review_due_date', 'is', null)
    .lte('review_due_date', inZevenDagen.toISOString().slice(0, 10));

  const reviews = (plans || [])
    .filter((p) => !['afgerond', 'geannuleerd'].includes(p.status))
    .map((p) => ({
    oppId: p.opp_id, schoolId: p.school_id, studentId: p.student_id, studentName: p.students?.full_name || null,
    ownerProfileId: p.students?.mentor_profile_id || null, reviewDueDate: p.review_due_date,
    overdue: Boolean(p.review_due_date && p.review_due_date < today), severity: p.review_due_date && p.review_due_date < today ? 'hoog' : 'normaal',
  }));

  return json({ ok: true, reviews, count: reviews.length });
}

async function handleOppSendReviewReminders(req: Request, admin: Admin) {
  const { reviews } = await req.json();
  let verstuurd = 0;
  for (const r of reviews || []) {
    if (!r.schoolId || !r.ownerProfileId) continue;
    const body = `De OPP-evaluatie voor ${r.studentName || 'deze leerling'} stond gepland op ${r.reviewDueDate}.`;
    await admin.from('tasks').insert({
      school_id: r.schoolId, title: `OPP-evaluatie: ${r.studentName || ''}`, description: `Deadline: ${r.reviewDueDate}.`,
      owner_profile_id: r.ownerProfileId, related_student_id: r.studentId || null, related_type: 'opp_plan', related_id: r.oppId || null, status: 'nieuw',
    });
    await notifyStaff(admin, { schoolId: r.schoolId, profileId: r.ownerProfileId, studentId: r.studentId || null, subject: `OPP-evaluatie ${r.overdue ? '(te laat) ' : ''}nodig: ${r.studentName || ''}`, body, templateKey: 'opp_review_due' });
    verstuurd++;
  }
  return json({ ok: true, remindersSent: verstuurd, totalReviews: (reviews || []).length });
}

async function handleCareMeetingsCandidates(admin: Admin) {
  const [{ data: signalStudentsRaw }, { data: oppStudentsRaw }] = await Promise.all([
    admin.from('signals').select('student_id, school_id, level, trigger_type, detail, status, students(full_name)').in('level', ['hoog', 'kritiek']),
    admin.from('opp_plans').select('student_id, school_id, status, students(full_name)'),
  ]);
  const signalStudents = (signalStudentsRaw || []).filter((s) => !['afgerond', 'geannuleerd'].includes(s.status));
  const oppStudents = (oppStudentsRaw || []).filter((o) => !['afgerond', 'geannuleerd'].includes(o.status));

  const perStudent = new Map<string, { studentId: string; schoolId: string; studentName: string; reasons: string[] }>();
  for (const s of signalStudents || []) {
    const key = s.student_id;
    const entry = perStudent.get(key) || { studentId: s.student_id, schoolId: s.school_id, studentName: s.students?.full_name || '', reasons: [] };
    entry.reasons.push(`Signaal (${s.level}): ${s.detail || s.trigger_type}`);
    perStudent.set(key, entry);
  }
  for (const o of oppStudents || []) {
    const key = o.student_id;
    const entry = perStudent.get(key) || { studentId: o.student_id, schoolId: o.school_id, studentName: o.students?.full_name || '', reasons: [] };
    entry.reasons.push(`Lopend OPP-traject (status: ${o.status})`);
    perStudent.set(key, entry);
  }

  return json({ ok: true, candidates: Array.from(perStudent.values()), count: perStudent.size });
}

async function handleCareMeetingsPrepareAgenda(req: Request, admin: Admin) {
  const body = await req.json();
  const candidates: Array<{ studentId: string; schoolId: string; studentName: string; reasons: string[] }> = Array.isArray(body) ? body : body.candidates || [];
  if (!candidates.length) return json({ ok: true, message: 'Geen kandidaten deze week.', agenda: null });

  const schoolId = candidates[0].schoolId;
  const system = `Je bent een zorgcoördinator-adviseur die een wekelijks zorgoverleg (MDO) voorbereidt. Voor elke aangeleverde kandidaat-leerling maak je een korte, feitelijke samenvatting en een voorstel voor bespreekpunten. Dit is een CONCEPT-agenda - de zorgcoördinator stelt de definitieve agenda vast en neemt de besluiten.

Antwoord UITSLUITEND met geldige JSON, geen markdown-opmaak:
{"agendaIntro": "korte inleidende tekst voor het overleg, in het Nederlands", "leerlingen": [{"studentId": "...", "samenvatting": "...", "bespreekpunten": ["..."]}]}`;
  const user = `Kandidaten: ${JSON.stringify(candidates)}`;
  const tekst = await callClaude(system, user, 3000);
  const parsed = parseClaudeJson<{ agendaIntro?: string; leerlingen?: Array<{ studentId: string; samenvatting: string; bespreekpunten: string[] }> }>(tekst, { agendaIntro: 'Kon het AI-antwoord niet als JSON parsen - controleer handmatig.', leerlingen: [] });

  const agendaTekst = [
    parsed.agendaIntro || '',
    ...(parsed.leerlingen || []).map((l) => {
      const naam = candidates.find((c) => c.studentId === l.studentId)?.studentName || l.studentId;
      return `\n${naam}:\n${l.samenvatting}\nBespreekpunten:\n- ${(l.bespreekpunten || []).join('\n- ')}`;
    }),
  ].join('\n');

  const { data: coordinator } = await admin.from('profiles').select('id').eq('school_id', schoolId).eq('role', 'zorgcoordinator').limit(1).maybeSingle();
  const volgendeWeek = new Date();
  volgendeWeek.setDate(volgendeWeek.getDate() + 7);
  if (coordinator?.id) {
    await admin.from('tasks').insert({
      school_id: schoolId, title: `Zorgoverleg (MDO) voorbereiden - ${candidates.length} kandidaten`,
      description: agendaTekst, owner_profile_id: coordinator.id, related_type: 'mdo_agenda', status: 'nieuw',
      due_date: volgendeWeek.toISOString().slice(0, 10),
    });
    await notifyStaff(admin, { schoolId, profileId: coordinator.id, subject: `Zorgoverleg (MDO) voorbereid - ${candidates.length} kandidaten`, body: agendaTekst, templateKey: 'mdo_agenda_ready' });
  }
  for (const c of candidates) {
    await admin.from('dossier_entries').insert({
      school_id: c.schoolId, student_id: c.studentId, entry_type: 'mdo_agenda',
      summary: `Besproken in MDO-voorbereiding: ${c.reasons.join('; ')}`,
    });
  }

  return json({ ok: true, agendaIntro: parsed.agendaIntro || '', candidateCount: candidates.length, agenda: agendaTekst });
}

// === Fase 5: toetsbank + surveillance + rooster/capaciteit ======================

// Fase 8: iedereen die iets moet weten krijgt een communications-rij
// (die WF16 daarna echt als e-mail verstuurt) - niet alleen een tasks-rij
// voor staff. student_id/guardian_id blijven het adresseringsmechanisme
// voor leerling/ouder; recipient_profile_id voor staff (zie schema.sql).
async function notifyStaff(admin: Admin, opts: { schoolId: string; profileId: string; studentId?: string | null; subject: string; body: string; templateKey: string }) {
  await admin.from('communications').insert({
    school_id: opts.schoolId, recipient_profile_id: opts.profileId, student_id: opts.studentId || null,
    channel: 'email', template_key: opts.templateKey, subject: opts.subject, body: opts.body, status: 'nieuw',
  });
}

async function notifyGuardiansAndStudent(admin: Admin, opts: { schoolId: string; studentId: string; subject: string; body: string; templateKey: string }) {
  const { data: guardianLinks } = await admin.from('student_guardians').select('guardian_id').eq('student_id', opts.studentId);
  for (const g of guardianLinks || []) {
    await admin.from('communications').insert({
      school_id: opts.schoolId, student_id: opts.studentId, guardian_id: g.guardian_id,
      channel: 'email', template_key: opts.templateKey, subject: opts.subject, body: opts.body, status: 'nieuw',
    });
  }
  // Leerling zelf (als die een eigen account heeft) krijgt dezelfde melding.
  await admin.from('communications').insert({
    school_id: opts.schoolId, student_id: opts.studentId,
    channel: 'email', template_key: opts.templateKey, subject: opts.subject, body: opts.body, status: 'nieuw',
  });
}

async function handleSchedulingFindSlot(req: Request, admin: Admin) {
  const { studentId, actionType, subjectId, preferredDateFrom, deadline, requiredSupervisorRole } = await req.json();
  if (!studentId) return json({ error: 'studentId is verplicht.' }, 400);

  const { data: student } = await admin.from('students').select('student_id, school_id, full_name, mentor_profile_id').eq('student_id', studentId).maybeSingle();
  if (!student) return json({ error: 'Leerling niet gevonden.' }, 404);

  const van = preferredDateFrom ? new Date(preferredDateFrom) : new Date();
  const tot = deadline ? new Date(deadline) : new Date(Date.now() + 30 * 24 * 3600 * 1000);
  const type = actionType === 'maatwerk' ? 'maatwerk' : 'inhaaltoets';

  if (type === 'inhaaltoets') {
    const { data: openMakeup } = await admin
      .from('makeup_tests')
      .select('makeup_test_id, missed_test_id, status, makeup_slot_id, missed_tests(student_id)')
      .eq('status', 'goedgekeurd')
      .is('makeup_slot_id', null);
    const eigen = (openMakeup || []).find((m) => m.missed_tests?.student_id === studentId);
    if (!eigen) return json({ ok: true, found: false, message: 'Geen goedgekeurde inhaaltoets klaar om in te plannen.' });

    const { data: slots } = await admin.from('makeup_slots').select('makeup_slot_id, school_id, starts_at, ends_at, location, capacity, supervisor_profile_id, profiles(role)')
      .eq('school_id', student.school_id).gte('starts_at', van.toISOString()).lte('starts_at', tot.toISOString()).order('starts_at', { ascending: true });

    for (const slot of slots || []) {
      if (requiredSupervisorRole && slot.profiles?.role && slot.profiles.role !== requiredSupervisorRole) continue;
      const { count } = await admin.from('makeup_tests').select('makeup_test_id', { count: 'exact', head: true }).eq('makeup_slot_id', slot.makeup_slot_id);
      if ((count || 0) < slot.capacity) {
        const { error } = await admin.from('makeup_tests').update({ makeup_slot_id: slot.makeup_slot_id, status: 'klaargezet_voor_afname' }).eq('makeup_test_id', eigen.makeup_test_id);
        if (error) throw error;

        const wanneer = new Date(slot.starts_at).toLocaleString('nl-NL', { weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' });
        const body = `${student.full_name} is ingepland voor de inhaaltoets op ${wanneer}${slot.location ? ` in ${slot.location}` : ''}.`;
        await notifyGuardiansAndStudent(admin, { schoolId: student.school_id, studentId, subject: `Inhaaltoets ingepland: ${student.full_name}`, body, templateKey: 'makeup_test_scheduled' });
        if (student.mentor_profile_id) {
          await notifyStaff(admin, { schoolId: student.school_id, profileId: student.mentor_profile_id, studentId, subject: `Inhaaltoets ingepland: ${student.full_name}`, body, templateKey: 'makeup_test_scheduled' });
        }

        return json({ ok: true, found: true, makeupTestId: eigen.makeup_test_id, slotId: slot.makeup_slot_id, startsAt: slot.starts_at, location: slot.location });
      }
    }
    return json({ ok: true, found: false, message: 'Geen beschikbaar inhaalmoment gevonden binnen de opgegeven periode.' });
  }

  const { data: openMaatwerk } = await admin
    .from('maatwerk_assignments')
    .select('assignment_id, student_id, subject_id, status, maatwerk_slot_id')
    .eq('student_id', studentId).eq('status', 'goedgekeurd').is('maatwerk_slot_id', null);
  const eigenMaatwerk = (openMaatwerk || [])[0];
  if (!eigenMaatwerk) return json({ ok: true, found: false, message: 'Geen goedgekeurd maatwerk klaar om in te plannen.' });

  let slotQuery = admin.from('maatwerk_slots').select('maatwerk_slot_id, starts_at, ends_at, capacity, subject_id')
    .eq('school_id', student.school_id).gte('starts_at', van.toISOString()).lte('starts_at', tot.toISOString()).order('starts_at', { ascending: true });
  if (subjectId) slotQuery = slotQuery.eq('subject_id', subjectId);
  const { data: maatwerkSlots } = await slotQuery;

  for (const slot of maatwerkSlots || []) {
    const { count } = await admin.from('maatwerk_assignments').select('assignment_id', { count: 'exact', head: true }).eq('maatwerk_slot_id', slot.maatwerk_slot_id);
    if ((count || 0) < slot.capacity) {
      const { error } = await admin.from('maatwerk_assignments').update({ maatwerk_slot_id: slot.maatwerk_slot_id, status: 'gepland' }).eq('assignment_id', eigenMaatwerk.assignment_id);
      if (error) throw error;

      const wanneer = new Date(slot.starts_at).toLocaleString('nl-NL', { weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' });
      const body = `${student.full_name} is ingepland voor een maatwerkuur op ${wanneer}.`;
      await notifyGuardiansAndStudent(admin, { schoolId: student.school_id, studentId, subject: `Maatwerkuur ingepland: ${student.full_name}`, body, templateKey: 'maatwerk_scheduled' });
      if (student.mentor_profile_id) {
        await notifyStaff(admin, { schoolId: student.school_id, profileId: student.mentor_profile_id, studentId, subject: `Maatwerkuur ingepland: ${student.full_name}`, body, templateKey: 'maatwerk_scheduled' });
      }

      return json({ ok: true, found: true, assignmentId: eigenMaatwerk.assignment_id, slotId: slot.maatwerk_slot_id, startsAt: slot.starts_at });
    }
  }
  return json({ ok: true, found: false, message: 'Geen beschikbaar maatwerkmoment gevonden binnen de opgegeven periode.' });
}

// Zet uit elk actief weekpatroon concrete, gedateerde slots voor de
// komende 6 weken - patronen zelf worden nooit rechtstreeks ingepland.
// Idempotent: slaat een (pattern_id, starts_at)-combinatie over als die
// al bestaat, dus veilig om vaker te draaien (knop + wekelijkse cron).
async function handleSchedulingGenerateSlots(admin: Admin) {
  const WEKEN_VOORUIT = 6;
  const vandaag = new Date();
  vandaag.setHours(0, 0, 0, 0);

  let makeupAangemaakt = 0;
  let maatwerkAangemaakt = 0;

  const { data: makeupPatterns } = await admin.from('makeup_slot_patterns').select('*').eq('active', true);
  for (const p of makeupPatterns || []) {
    for (let dag = 0; dag < WEKEN_VOORUIT * 7; dag++) {
      const datum = new Date(vandaag);
      datum.setDate(datum.getDate() + dag);
      const isoWeekdag = ((datum.getDay() + 6) % 7) + 1; // JS: 0=zondag -> ISO: 1=maandag..7=zondag
      if (isoWeekdag !== p.weekday) continue;
      const dagStr = datum.toISOString().slice(0, 10);
      const startsAt = new Date(`${dagStr}T${p.start_time}`);
      const endsAt = new Date(`${dagStr}T${p.end_time}`);
      if (startsAt < new Date()) continue;

      const { data: bestaand } = await admin.from('makeup_slots').select('makeup_slot_id').eq('pattern_id', p.pattern_id).eq('starts_at', startsAt.toISOString()).maybeSingle();
      if (bestaand) continue;

      const { error } = await admin.from('makeup_slots').insert({
        school_id: p.school_id, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(),
        location: p.location, supervisor_profile_id: p.supervisor_profile_id, capacity: p.capacity, pattern_id: p.pattern_id,
      });
      if (!error) makeupAangemaakt++;
    }
  }

  const { data: maatwerkPatterns } = await admin.from('maatwerk_slot_patterns').select('*').eq('active', true);
  for (const p of maatwerkPatterns || []) {
    for (let dag = 0; dag < WEKEN_VOORUIT * 7; dag++) {
      const datum = new Date(vandaag);
      datum.setDate(datum.getDate() + dag);
      const isoWeekdag = ((datum.getDay() + 6) % 7) + 1;
      if (isoWeekdag !== p.weekday) continue;
      const dagStr = datum.toISOString().slice(0, 10);
      const startsAt = new Date(`${dagStr}T${p.start_time}`);
      const endsAt = new Date(`${dagStr}T${p.end_time}`);
      if (startsAt < new Date()) continue;

      const { data: bestaand } = await admin.from('maatwerk_slots').select('maatwerk_slot_id').eq('pattern_id', p.pattern_id).eq('starts_at', startsAt.toISOString()).maybeSingle();
      if (bestaand) continue;

      const { error } = await admin.from('maatwerk_slots').insert({
        school_id: p.school_id, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(),
        subject_id: p.subject_id, teacher_profile_id: p.teacher_profile_id, capacity: p.capacity, pattern_id: p.pattern_id,
      });
      if (!error) maatwerkAangemaakt++;
    }
  }

  return json({ ok: true, makeupSlotsCreated: makeupAangemaakt, maatwerkSlotsCreated: maatwerkAangemaakt });
}

// Poll-paar voor WF16 (e-mailmeldingen versturen) - zelfde patroon als
// actions/due + actions/send-reminders. `pending` lost het echte
// e-mailadres op; rijen zonder resolveerbaar adres worden overgeslagen
// (blijven status 'nieuw' staan, komen bij de volgende poll terug pas
// mee zodra het adres wel resolveert - voorkomt stille dataverlies).
async function handleCommunicationsPending(admin: Admin) {
  const { data: rows } = await admin
    .from('communications')
    .select('communication_id, school_id, subject, body, channel, recipient_profile_id, guardian_id, student_id, profiles(email, full_name), guardians(email, full_name), students(profile_id)')
    .eq('status', 'nieuw')
    .order('created_at', { ascending: true })
    .limit(200);

  const pending = [];
  for (const r of rows || []) {
    let email = null;
    let naam = null;
    if (r.recipient_profile_id) {
      email = r.profiles?.email || null;
      naam = r.profiles?.full_name || null;
    } else if (r.guardian_id) {
      email = r.guardians?.email || null;
      naam = r.guardians?.full_name || null;
    } else if (r.student_id && r.students?.profile_id) {
      const { data: leerlingProfiel } = await admin.from('profiles').select('email, full_name').eq('id', r.students.profile_id).maybeSingle();
      email = leerlingProfiel?.email || null;
      naam = leerlingProfiel?.full_name || null;
    }
    if (!email) continue;
    pending.push({ communicationId: r.communication_id, email, naam, subject: r.subject, body: r.body });
  }

  return json({ ok: true, pending, count: pending.length });
}

async function handleCommunicationsMarkSent(req: Request, admin: Admin) {
  const { communicationIds } = await req.json();
  if (!Array.isArray(communicationIds) || !communicationIds.length) return json({ ok: true, marked: 0 });
  const { error } = await admin.from('communications').update({ status: 'afgerond', sent_at: new Date().toISOString() }).in('communication_id', communicationIds);
  if (error) throw error;
  return json({ ok: true, marked: communicationIds.length });
}

async function handleSupervisionToday(admin: Admin) {
  const vandaag = new Date().toISOString().slice(0, 10);
  const { data: slots } = await admin
    .from('makeup_slots')
    .select('makeup_slot_id, school_id, starts_at, ends_at, location, supervisor_profile_id, profiles(full_name), makeup_tests(makeup_test_id, status, missed_tests(students(full_name)))')
    .gte('starts_at', `${vandaag}T00:00:00`).lte('starts_at', `${vandaag}T23:59:59`)
    .order('starts_at', { ascending: true });

  const perSupervisor = new Map<string, { supervisorId: string; supervisorName: string; slots: unknown[] }>();
  for (const slot of slots || []) {
    const key = slot.supervisor_profile_id || 'onbekend';
    const entry = perSupervisor.get(key) || { supervisorId: key, supervisorName: slot.profiles?.full_name || 'Nog niet toegewezen', slots: [] };
    entry.slots.push({
      slotId: slot.makeup_slot_id, startsAt: slot.starts_at, endsAt: slot.ends_at, location: slot.location,
      students: (slot.makeup_tests || []).filter((m: { status: string }) => m.status === 'klaargezet_voor_afname').map((m: { makeup_test_id: string; missed_tests?: { students?: { full_name: string } } }) => ({ makeupTestId: m.makeup_test_id, studentName: m.missed_tests?.students?.full_name || null })),
    });
    perSupervisor.set(key, entry);
  }

  return json({ ok: true, daylist: Array.from(perSupervisor.values()), date: vandaag });
}

async function handleSupervisionSendDayList(req: Request, admin: Admin) {
  const { daylist } = await req.json();
  let verstuurd = 0;
  for (const entry of daylist || []) {
    if (!entry.supervisorId || entry.supervisorId === 'onbekend' || !entry.slots?.length) continue;
    const school = await admin.from('makeup_slots').select('school_id').eq('makeup_slot_id', entry.slots[0].slotId).maybeSingle();
    if (!school.data) continue;
    const tekst = entry.slots.map((s: { startsAt: string; location: string; students: Array<{ studentName: string }> }) =>
      `${new Date(s.startsAt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })} - ${s.location || 'geen lokaal'}: ${s.students.map((st) => st.studentName).join(', ') || 'geen leerlingen'}`
    ).join('\n');
    await admin.from('tasks').insert({
      school_id: school.data.school_id, title: 'Surveillance-daglijst van vandaag', description: tekst,
      owner_profile_id: entry.supervisorId, related_type: 'supervision_day', status: 'nieuw', due_date: new Date().toISOString().slice(0, 10),
    });
    verstuurd++;
  }
  return json({ ok: true, sent: verstuurd });
}

async function handleTestbankDocuments(req: Request, admin: Admin) {
  const { testId, documentType, fileUrl, textContent, learningObjectives } = await req.json();
  if (!testId) return json({ error: 'testId is verplicht.' }, 400);

  const { data: test } = await admin.from('tests').select('test_id, school_id').eq('test_id', testId).maybeSingle();
  if (!test) return json({ error: 'Toets niet gevonden.' }, 404);

  const kindMap: Record<string, string> = { originele_toets: 'origineel', antwoordmodel: 'antwoordmodel', inhaaltoets_variant: 'ai_variant' };
  const kind = kindMap[documentType] || 'origineel';
  // 'origineel'/'antwoordmodel' via dit endpoint zijn door een docent
  // geüpload, geen AI-product - dus geen AI-review nodig, in
  // tegenstelling tot ai_variant-documenten uit de inhaaltoets-flow.
  const isAiKind = kind === 'ai_variant';
  const status = isAiKind ? 'nieuw' : 'goedgekeurd';
  const content = [textContent, Array.isArray(learningObjectives) && learningObjectives.length ? `Leerdoelen: ${learningObjectives.join(', ')}` : null].filter(Boolean).join('\n\n') || null;

  const { data: doc, error } = await admin
    .from('test_documents')
    .insert({ school_id: test.school_id, test_id: testId, kind, file_url: fileUrl || null, content, status, ai_human_review_required: isAiKind })
    .select('document_id')
    .single();
  if (error) throw error;

  return json({ ok: true, documentId: doc.document_id, kind, status });
}

// === Fase 6: management cockpit + import/koppelingen ============================

async function computeSchoolMetrics(admin: Admin, schoolId: string) {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 3600 * 1000);

  const [missed, openMakeup, noShows, attendanceThisWeek, attendancePrevWeek, maatwerk, signals, opp, tasks] = await Promise.all([
    admin.from('missed_tests').select('missed_test_id', { count: 'exact', head: true }).eq('school_id', schoolId).gte('created_at', weekAgo.toISOString()),
    admin.from('makeup_tests').select('makeup_test_id', { count: 'exact', head: true }).eq('school_id', schoolId).eq('status', 'wacht_op_goedkeuring'),
    admin.from('makeup_tests').select('makeup_test_id', { count: 'exact', head: true }).eq('school_id', schoolId).eq('status', 'no_show').gte('created_at', weekAgo.toISOString()),
    admin.from('attendance_events').select('event_type').eq('school_id', schoolId).gte('event_date', weekAgo.toISOString().slice(0, 10)),
    admin.from('attendance_events').select('event_type').eq('school_id', schoolId).gte('event_date', twoWeeksAgo.toISOString().slice(0, 10)).lt('event_date', weekAgo.toISOString().slice(0, 10)),
    admin.from('maatwerk_assignments').select('status').eq('school_id', schoolId),
    admin.from('signals').select('level, status').eq('school_id', schoolId).in('level', ['hoog', 'kritiek']),
    admin.from('opp_plans').select('status').eq('school_id', schoolId),
    admin.from('tasks').select('owner_profile_id, status, profiles(full_name)').eq('school_id', schoolId).in('status', ['nieuw', 'in_behandeling']),
  ]);

  const tellen = (rows: Array<{ status?: string }> | null, key: 'status' = 'status') => {
    const map: Record<string, number> = {};
    for (const r of rows || []) { const v = (r as Record<string, string>)[key] || 'onbekend'; map[v] = (map[v] || 0) + 1; }
    return map;
  };
  const tellenPerType = (rows: Array<{ event_type: string }> | null) => {
    const map: Record<string, number> = {};
    for (const r of rows || []) map[r.event_type] = (map[r.event_type] || 0) + 1;
    return map;
  };
  const openActiesPerEigenaar: Record<string, number> = {};
  for (const t of tasks.data || []) {
    const naam = t.profiles?.full_name || 'Niet toegewezen';
    openActiesPerEigenaar[naam] = (openActiesPerEigenaar[naam] || 0) + 1;
  }
  const openSignalen = (signals.data || []).filter((s) => !['afgerond', 'geannuleerd'].includes(s.status));

  return {
    schoolId,
    missedTestsDezeWeek: missed.count || 0,
    openInhaaltoetsen: openMakeup.count || 0,
    noShowsDezeWeek: noShows.count || 0,
    verzuimDezeWeek: tellenPerType(attendanceThisWeek.data as Array<{ event_type: string }>),
    verzuimVorigeWeek: tellenPerType(attendancePrevWeek.data as Array<{ event_type: string }>),
    maatwerkStatus: tellen(maatwerk.data),
    groteSignalenOpen: openSignalen.length,
    oppStatus: tellen(opp.data),
    openActiesPerEigenaar,
  };
}

async function handleManagementWeeklyData(admin: Admin) {
  const { data: schools } = await admin.from('schools').select('school_id');
  const resultaten = [];
  for (const s of schools || []) resultaten.push(await computeSchoolMetrics(admin, s.school_id));
  return json({ ok: true, schools: resultaten, generatedAt: new Date().toISOString() });
}

async function handleManagementGenerateReport(req: Request, admin: Admin) {
  const { schools } = await req.json();
  const system = `Je bent een data-analist die een wekelijks managementrapport schrijft voor de directie/teamleiding van een middelbare school, gebaseerd op cijfers uit SchoolRegie. Schrijf zakelijk, feitelijk en beknopt (200-300 woorden), noem concrete getallen, en sluit af met de belangrijkste aandachtspunten. Geen markdown-opmaak.

Antwoord UITSLUITEND met geldige JSON: {"reportText": "het volledige rapport als platte tekst, in het Nederlands"}`;
  const resultaten = [];
  for (const s of schools || []) {
    const user = `Cijfers van deze week: ${JSON.stringify(s)}`;
    const tekst = await callClaude(system, user, 1500);
    const parsed = parseClaudeJson<{ reportText?: string }>(tekst, { reportText: 'Kon het AI-antwoord niet als JSON parsen - controleer handmatig.' });
    resultaten.push({ schoolId: s.schoolId, reportText: parsed.reportText || '' });
  }
  void admin;
  return json({ ok: true, schools: resultaten });
}

async function handleManagementSendReport(req: Request, admin: Admin) {
  const { schools } = await req.json();
  let verstuurd = 0;
  for (const s of schools || []) {
    if (!s.schoolId) continue;
    const { data: ontvangers } = await admin.from('profiles').select('id').eq('school_id', s.schoolId).in('role', ['directie', 'teamleider', 'kwaliteitsmedewerker']);
    for (const o of ontvangers || []) {
      await admin.from('tasks').insert({
        school_id: s.schoolId, title: 'Wekelijks managementrapport', description: s.reportText,
        owner_profile_id: o.id, related_type: 'management_report', status: 'nieuw',
      });
      verstuurd++;
    }
  }
  return json({ ok: true, sent: verstuurd });
}

async function handleIntegrationsLvsImport(req: Request, admin: Admin) {
  const { source, students, grades, attendance, schedules, classes, subjects, guardians } = await req.json();

  let schoolId = null;
  const { data: scholen } = await admin.from('schools').select('school_id');
  if (scholen && scholen.length === 1) schoolId = scholen[0].school_id;
  if (!schoolId) return json({ error: 'Kan de school niet bepalen (meerdere scholen aanwezig) - schoolId ontbreekt in de importdata. De n8n-normalisatiestap voor deze workflow moet schoolId doorgeven zodra er meer dan één school actief is.' }, 400);

  const { data: klassen } = await admin.from('classes').select('class_id, name').eq('school_id', schoolId);
  const klasPerNaam = new Map((klassen || []).map((k) => [k.name, k.class_id]));

  let leerlingenVerwerkt = 0;
  for (const s of students || []) {
    const classId = s.className ? klasPerNaam.get(s.className) || null : null;
    const { data: bestaand } = s.studentNumber
      ? await admin.from('students').select('student_id').eq('school_id', schoolId).eq('student_number', s.studentNumber).maybeSingle()
      : { data: null };
    if (bestaand) {
      await admin.from('students').update({ full_name: s.fullName || undefined, class_id: classId, level: s.level || undefined, year: s.year || undefined }).eq('student_id', bestaand.student_id);
    } else if (s.fullName) {
      await admin.from('students').insert({ school_id: schoolId, student_number: s.studentNumber || null, full_name: s.fullName, class_id: classId, level: s.level || null, year: s.year || null });
    }
    leerlingenVerwerkt++;
  }

  let verzuimVerwerkt = 0;
  for (const a of attendance || []) {
    let studentId = a.studentId || null;
    if (!studentId && a.studentNumber) {
      const { data: st } = await admin.from('students').select('student_id').eq('school_id', schoolId).eq('student_number', a.studentNumber).maybeSingle();
      studentId = st?.student_id || null;
    }
    if (!studentId || !a.eventType) continue;
    await admin.from('attendance_events').insert({ school_id: schoolId, student_id: studentId, event_type: a.eventType, event_date: (a.eventDate || new Date().toISOString()).slice(0, 10), note: `Import (${source || 'lvs'})` });
    verzuimVerwerkt++;
  }

  let klassenVerwerkt = 0;
  for (const c of classes || []) {
    if (!c.name) continue;
    const { data: bestaand } = await admin.from('classes').select('class_id').eq('school_id', schoolId).eq('name', c.name).maybeSingle();
    const payload = { level: c.level || null, year: c.year || null };
    const { error } = bestaand
      ? await admin.from('classes').update(payload).eq('class_id', bestaand.class_id)
      : await admin.from('classes').insert({ school_id: schoolId, name: c.name, ...payload });
    if (!error) klassenVerwerkt++;
  }

  let vakkenVerwerkt = 0;
  for (const s of subjects || []) {
    if (!s.name) continue;
    const { data: bestaand } = await admin.from('subjects').select('subject_id').eq('school_id', schoolId).eq('name', s.name).maybeSingle();
    const payload = { code: s.code || null };
    const { error } = bestaand
      ? await admin.from('subjects').update(payload).eq('subject_id', bestaand.subject_id)
      : await admin.from('subjects').insert({ school_id: schoolId, name: s.name, ...payload });
    if (!error) vakkenVerwerkt++;
  }

  let oudersVerwerkt = 0;
  for (const g of guardians || []) {
    if (!g.fullName || !g.studentNumber) continue;
    const { data: student } = await admin.from('students').select('student_id').eq('school_id', schoolId).eq('student_number', g.studentNumber).maybeSingle();
    if (!student) continue;
    const { data: bestaand } = g.email
      ? await admin.from('guardians').select('guardian_id').eq('school_id', schoolId).eq('email', g.email).maybeSingle()
      : { data: null };
    const payload = { full_name: g.fullName, email: g.email || null, phone: g.phone || null };
    let guardianId = bestaand?.guardian_id;
    if (bestaand) {
      await admin.from('guardians').update(payload).eq('guardian_id', bestaand.guardian_id);
    } else {
      const { data: nieuw, error } = await admin.from('guardians').insert({ school_id: schoolId, ...payload }).select('guardian_id').single();
      if (error) continue;
      guardianId = nieuw.guardian_id;
    }
    const { data: link } = await admin.from('student_guardians').select('student_id').eq('student_id', student.student_id).eq('guardian_id', guardianId).maybeSingle();
    if (!link) await admin.from('student_guardians').insert({ student_id: student.student_id, guardian_id: guardianId, relation: g.relation || null });
    oudersVerwerkt++;
  }

  const importRows = [
    { kind: 'leerlingen', count: leerlingenVerwerkt, total: (students || []).length },
    { kind: 'verzuim', count: verzuimVerwerkt, total: (attendance || []).length },
    { kind: 'klassen', count: klassenVerwerkt, total: (classes || []).length },
    { kind: 'vakken', count: vakkenVerwerkt, total: (subjects || []).length },
    { kind: 'ouders', count: oudersVerwerkt, total: (guardians || []).length },
  ];
  for (const r of importRows) {
    if (r.total === 0) continue;
    await admin.from('imports').insert({ school_id: schoolId, kind: r.kind, filename: `lvs-import-${source || 'onbekend'}`, status: 'afgerond', imported_count: r.count, error_count: r.total - r.count });
  }
  // cijfers/rooster: geen persistente tabel in dit schema (zie Fase 4) -
  // bewust alleen genoteerd, niet verwerkt (docenten/personeel blijft ook
  // bewust ongemoeid: een login-account aanmaken is een bewuste,
  // beveiligingsgevoelige actie die via Schoolbeheer loopt, niet via een
  // CSV-import zonder toezicht).
  const genegeerd = { grades: (grades || []).length, schedules: (schedules || []).length };

  return json({
    ok: true, schoolId,
    students: { processed: leerlingenVerwerkt, total: (students || []).length },
    attendance: { processed: verzuimVerwerkt, total: (attendance || []).length },
    classes: { processed: klassenVerwerkt, total: (classes || []).length },
    subjects: { processed: vakkenVerwerkt, total: (subjects || []).length },
    guardians: { processed: oudersVerwerkt, total: (guardians || []).length },
    notProcessed: genegeerd,
  });
}

// === Router ======================================================================

const ROUTES: Record<string, (req: Request, admin: Admin) => Promise<Response>> = {
  'POST /missed-tests': handleMissedTests,
  'POST /makeup-tests/generate': handleMakeupTestsGenerate,
  'POST /tasks/teacher-review': handleTasksTeacherReview,
  'GET /actions/due': (_req, admin) => handleActionsDue(admin),
  'POST /actions/send-reminders': handleActionsSendReminders,
  'POST /attendance/signals': handleAttendanceSignals,
  'POST /interventions/advice': handleInterventionsAdvice,
  'POST /signals/major': handleSignalsMajor,
  'POST /meetings/parent-conversation/propose': handleMeetingsParentConversationPropose,
  'POST /communications/prepare': handleCommunicationsPrepare,
  'POST /opp/start': handleOppStart,
  'POST /opp/prepare-summary': handleOppPrepareSummary,
  'GET /opp/due-reviews': (_req, admin) => handleOppDueReviews(admin),
  'POST /opp/send-review-reminders': handleOppSendReviewReminders,
  'GET /care-meetings/candidates': (_req, admin) => handleCareMeetingsCandidates(admin),
  'POST /care-meetings/prepare-agenda': handleCareMeetingsPrepareAgenda,
  'POST /scheduling/find-slot': handleSchedulingFindSlot,
  'GET /supervision/today': (_req, admin) => handleSupervisionToday(admin),
  'POST /supervision/send-day-list': handleSupervisionSendDayList,
  'POST /testbank/documents': handleTestbankDocuments,
  'GET /management/weekly-data': (_req, admin) => handleManagementWeeklyData(admin),
  'POST /management/generate-report': handleManagementGenerateReport,
  'POST /management/send-report': handleManagementSendReport,
  'POST /integrations/lvs/import': handleIntegrationsLvsImport,
  'POST /scheduling/generate-slots': (_req, admin) => handleSchedulingGenerateSlots(admin),
  'GET /communications/pending': (_req, admin) => handleCommunicationsPending(admin),
  'POST /communications/mark-sent': handleCommunicationsMarkSent,
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const authError = requireApiKey(req);
  if (authError) return authError;

  // Eén gedeelde limiet voor de hele router (niet per sub-route): dit is
  // n8n-only verkeer, dus vooral een vangnet tegen een gelekte API-sleutel
  // of een vastgelopen workflow die in een lus komt, niet tegen normaal
  // gebruik.
  const rlAdmin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { allowed } = await checkRateLimit(rlAdmin, 'schoolregie-api-n8n', 300, 60);
  if (!allowed) return json({ error: 'Te veel verzoeken. Probeer het over een minuut opnieuw.' }, 429);

  const url = new URL(req.url);
  const marker = '/api/n8n';
  const idx = url.pathname.indexOf(marker);
  const route = idx === -1 ? url.pathname : url.pathname.slice(idx + marker.length).replace(/\/$/, '') || '/';
  const key = `${req.method} ${route}`;
  const handler = ROUTES[key];
  if (!handler) return json({ error: `Onbekende route: ${key}` }, 404);

  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    return await handler(req, admin);
  } catch (err) {
    return json({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
