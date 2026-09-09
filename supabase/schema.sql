-- SchoolRegie: schema + RLS (buildless, Fase 0 - fundament)
-- Multi-tenant via school_id op elke tabel. Patroon overgenomen van de
-- andere 4 producten dit traject (security definer-helperfuncties +
-- per-tabel RLS-policies).
--
-- RLS-aanpak in Fase 0: de 9 "personeels"-rollen (alles behalve ouder/
-- leerling) krijgen volledige CRUD binnen hun eigen school op alle
-- tabellen - verfijning per rol (bv. "alleen vakdocent mag een toets
-- aanmaken") volgt per module in de fase die die module bouwt, niet nu al
-- geraden. Ouder/leerling krijgen in Fase 0 bewust GEEN policies (dus
-- overal RLS-default-deny) - hun eigen, sterk beperkte zicht (eigen
-- kind/eigen leerling-record) wordt toegevoegd zodra hun portalpagina's
-- gebouwd worden (Fase 1+), niet blind vooraf geraden.

create extension if not exists "pgcrypto";

-- === Vaste statusverzameling (spec: "gebruik overal heldere statussen") =====
-- Eén gedeeld vocabulaire over alle procestabellen heen; niet elke status
-- is voor elke tabel relevant (bv. "no_show" vooral bij makeup_tests/
-- maatwerk_assignments), maar één check-constraint-lijst houdt dit simpel
-- en consistent i.p.v. per tabel een eigen enum.
-- nieuw, gepland, wacht_op_toets, wacht_op_goedkeuring, goedgekeurd,
-- klaargezet_voor_afname, afgenomen, in_behandeling, afgerond, verlopen,
-- no_show, geescaleerd, geannuleerd

-- === Kern: school, rollen, mensen ============================================

create table schools (
  school_id uuid primary key default gen_random_uuid(),
  name text not null,
  brin text,
  address text,
  created_at timestamptz not null default now()
);

create table school_settings (
  school_id uuid primary key references schools(school_id) on delete cascade,
  attendance_late_threshold int not null default 3,
  attendance_unauthorized_threshold int not null default 3,
  attendance_truancy_threshold int not null default 1,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- profiles = "users" uit de spec: elk ingelogd account (personeel, en
-- optioneel ouder/leerling als die ooit een eigen login krijgen).
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  school_id uuid references schools(school_id) on delete cascade,
  role text not null check (role in (
    'administrator','directie','teamleider','mentor','vakdocent',
    'surveillant','verzuimcoordinator','zorgcoordinator',
    'kwaliteitsmedewerker','ouder','leerling'
  )),
  full_name text not null,
  email text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_profiles_school on profiles(school_id);

create table classes (
  class_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  name text not null,
  level text,
  year int,
  mentor_profile_id uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_classes_school on classes(school_id);

create table subjects (
  subject_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  name text not null,
  code text,
  created_at timestamptz not null default now()
);
create index if not exists idx_subjects_school on subjects(school_id);

create table students (
  student_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  profile_id uuid references profiles(id) on delete set null,
  class_id uuid references classes(class_id) on delete set null,
  student_number text,
  full_name text not null,
  level text,
  year int,
  mentor_profile_id uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_students_school on students(school_id);
create index if not exists idx_students_class on students(class_id);

create table guardians (
  guardian_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  profile_id uuid references profiles(id) on delete set null,
  full_name text not null,
  email text,
  phone text,
  created_at timestamptz not null default now()
);
create index if not exists idx_guardians_school on guardians(school_id);

create table student_guardians (
  student_id uuid not null references students(student_id) on delete cascade,
  guardian_id uuid not null references guardians(guardian_id) on delete cascade,
  relation text,
  primary key (student_id, guardian_id)
);

create table courses (
  course_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  subject_id uuid not null references subjects(subject_id) on delete cascade,
  class_id uuid not null references classes(class_id) on delete cascade,
  teacher_profile_id uuid references profiles(id) on delete set null,
  schooljaar text,
  created_at timestamptz not null default now()
);
create index if not exists idx_courses_school on courses(school_id);

-- === Toetsen, gemiste toetsen, inhaal (module 1-2) ===========================

create table tests (
  test_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  course_id uuid references courses(course_id) on delete set null,
  subject_id uuid references subjects(subject_id) on delete set null,
  class_id uuid references classes(class_id) on delete set null,
  teacher_profile_id uuid references profiles(id) on delete set null,
  title text not null,
  test_date date,
  weight numeric,
  created_at timestamptz not null default now()
);
create index if not exists idx_tests_school on tests(school_id);

create table makeup_slots (
  makeup_slot_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  location text,
  supervisor_profile_id uuid references profiles(id) on delete set null,
  capacity int not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists idx_makeup_slots_school on makeup_slots(school_id);

create table test_documents (
  document_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  test_id uuid references tests(test_id) on delete cascade,
  kind text not null check (kind in ('origineel','ai_variant','antwoordmodel')),
  version int not null default 1,
  file_url text,
  content text,
  status text not null default 'nieuw',
  ai_confidence numeric,
  ai_human_review_required boolean not null default true,
  ai_reason text,
  ai_data_used jsonb,
  approved_by uuid references profiles(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_test_documents_school on test_documents(school_id);
create index if not exists idx_test_documents_test on test_documents(test_id);

create table missed_tests (
  missed_test_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  student_id uuid not null references students(student_id) on delete cascade,
  test_id uuid references tests(test_id) on delete set null,
  reason text,
  status text not null default 'nieuw',
  created_at timestamptz not null default now()
);
create index if not exists idx_missed_tests_school on missed_tests(school_id);
create index if not exists idx_missed_tests_student on missed_tests(student_id);

create table makeup_tests (
  makeup_test_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  missed_test_id uuid not null references missed_tests(missed_test_id) on delete cascade,
  document_id uuid references test_documents(document_id) on delete set null,
  makeup_slot_id uuid references makeup_slots(makeup_slot_id) on delete set null,
  status text not null default 'nieuw',
  no_show_count int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_makeup_tests_school on makeup_tests(school_id);
create index if not exists idx_makeup_tests_missed on makeup_tests(missed_test_id);

-- AI-varianten/antwoordmodellen worden per gemiste-toets-instantie
-- gegenereerd (niet per toets) - anders zou het beoordelen van leerling A's
-- concept per ongeluk leerling B's concept kunnen tonen als twee leerlingen
-- dezelfde toets missen. test_id blijft voor het "origineel"-document.
alter table test_documents add column if not exists missed_test_id uuid references missed_tests(missed_test_id) on delete cascade;
create index if not exists idx_test_documents_missed_test on test_documents(missed_test_id);

-- === Verzuim, interventies, maatwerk (module 3-4) ============================

create table attendance_events (
  event_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  student_id uuid not null references students(student_id) on delete cascade,
  event_type text not null check (event_type in ('te_laat','ongeoorloofd_afwezig','spijbelen','geoorloofd_afwezig')),
  event_date date not null,
  minutes int,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists idx_attendance_events_school on attendance_events(school_id);
create index if not exists idx_attendance_events_student on attendance_events(student_id);

create table interventions (
  intervention_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  student_id uuid not null references students(student_id) on delete cascade,
  kind text not null,
  status text not null default 'nieuw',
  owner_profile_id uuid references profiles(id) on delete set null,
  due_date date,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists idx_interventions_school on interventions(school_id);
create index if not exists idx_interventions_student on interventions(student_id);

create table maatwerk_slots (
  maatwerk_slot_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  subject_id uuid references subjects(subject_id) on delete set null,
  teacher_profile_id uuid references profiles(id) on delete set null,
  starts_at timestamptz,
  ends_at timestamptz,
  capacity int not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists idx_maatwerk_slots_school on maatwerk_slots(school_id);

create table maatwerk_assignments (
  assignment_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  student_id uuid not null references students(student_id) on delete cascade,
  maatwerk_slot_id uuid references maatwerk_slots(maatwerk_slot_id) on delete set null,
  subject_id uuid references subjects(subject_id) on delete set null,
  status text not null default 'nieuw',
  advice_reason text,
  mentor_approved boolean not null default false,
  no_show_count int not null default 0,
  effect_measured_at timestamptz,
  effect_notes text,
  created_at timestamptz not null default now()
);
create index if not exists idx_maatwerk_assignments_school on maatwerk_assignments(school_id);
create index if not exists idx_maatwerk_assignments_student on maatwerk_assignments(student_id);

-- === Signalen, taken (module 5) ===============================================

create table signals (
  signal_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  student_id uuid not null references students(student_id) on delete cascade,
  level text not null check (level in ('laag','middel','hoog','kritiek')),
  trigger_type text not null,
  detail text,
  status text not null default 'nieuw',
  created_at timestamptz not null default now()
);
create index if not exists idx_signals_school on signals(school_id);
create index if not exists idx_signals_student on signals(student_id);

create table tasks (
  task_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  title text not null,
  description text,
  owner_profile_id uuid references profiles(id) on delete set null,
  related_student_id uuid references students(student_id) on delete set null,
  related_type text,
  related_id uuid,
  status text not null default 'nieuw',
  due_date date,
  created_at timestamptz not null default now()
);
create index if not exists idx_tasks_school on tasks(school_id);
create index if not exists idx_tasks_owner on tasks(owner_profile_id);

-- === Communicatie, gesprekken (module 6) ======================================

create table communications (
  communication_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  student_id uuid references students(student_id) on delete set null,
  guardian_id uuid references guardians(guardian_id) on delete set null,
  channel text check (channel in ('email','sms','app','whatsapp')),
  template_key text,
  subject text,
  body text,
  status text not null default 'nieuw',
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_communications_school on communications(school_id);

create table conversations (
  conversation_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  student_id uuid not null references students(student_id) on delete cascade,
  kind text not null default 'oudergesprek',
  proposed_by uuid references profiles(id) on delete set null,
  scheduled_at timestamptz,
  confirmed_by_guardian boolean not null default false,
  status text not null default 'nieuw',
  created_at timestamptz not null default now()
);
create index if not exists idx_conversations_school on conversations(school_id);
create index if not exists idx_conversations_student on conversations(student_id);

create table conversation_notes (
  note_id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(conversation_id) on delete cascade,
  author_profile_id uuid references profiles(id) on delete set null,
  note text not null,
  created_at timestamptz not null default now()
);

-- === OPP, zorg, dossier (module 7-8) ==========================================

create table opp_plans (
  opp_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  student_id uuid not null references students(student_id) on delete cascade,
  status text not null default 'nieuw',
  ai_summary text,
  ai_confidence numeric,
  ai_human_review_required boolean not null default true,
  ai_data_used jsonb,
  started_by uuid references profiles(id) on delete set null,
  started_at timestamptz default now(),
  review_due_date date,
  created_at timestamptz not null default now()
);
create index if not exists idx_opp_plans_school on opp_plans(school_id);
create index if not exists idx_opp_plans_student on opp_plans(student_id);

create table opp_goals (
  goal_id uuid primary key default gen_random_uuid(),
  opp_id uuid not null references opp_plans(opp_id) on delete cascade,
  description text not null,
  target_date date,
  status text not null default 'nieuw',
  created_at timestamptz not null default now()
);

create table opp_actions (
  opp_action_id uuid primary key default gen_random_uuid(),
  opp_id uuid not null references opp_plans(opp_id) on delete cascade,
  goal_id uuid references opp_goals(goal_id) on delete set null,
  description text not null,
  owner_profile_id uuid references profiles(id) on delete set null,
  due_date date,
  status text not null default 'nieuw',
  created_at timestamptz not null default now()
);

create table dossier_entries (
  entry_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  student_id uuid not null references students(student_id) on delete cascade,
  entry_type text,
  related_type text,
  related_id uuid,
  summary text not null,
  author_profile_id uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_dossier_entries_school on dossier_entries(school_id);
create index if not exists idx_dossier_entries_student on dossier_entries(student_id);

-- === Audit, integraties, import, templates (beheer) ===========================

create table audit_logs (
  log_id uuid primary key default gen_random_uuid(),
  school_id uuid references schools(school_id) on delete cascade,
  actor_profile_id uuid references profiles(id) on delete set null,
  action text not null,
  entity_type text,
  entity_id uuid,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_logs_school on audit_logs(school_id);

create table integrations (
  integration_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  provider text not null check (provider in ('magister','somtoday','zermelo','untis','google_calendar','outlook','teams','email','sms','whatsapp')),
  status text not null default 'niet_gekoppeld',
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (school_id, provider)
);

create table imports (
  import_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  kind text not null check (kind in ('leerlingen','ouders','docenten','klassen','vakken','cijfers','verzuim','rooster')),
  filename text,
  status text not null default 'nieuw',
  imported_count int not null default 0,
  error_count int not null default 0,
  imported_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_imports_school on imports(school_id);

create table notification_templates (
  template_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  key text not null,
  channel text not null check (channel in ('email','sms','app','whatsapp')),
  subject text,
  body text not null,
  created_at timestamptz not null default now(),
  unique (school_id, key, channel)
);

-- === RLS-helperfuncties ========================================================

create or replace function current_school_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select school_id from profiles where id = auth.uid();
$$;

create or replace function current_rol()
returns text
language sql stable security definer set search_path = public
as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function is_staff()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select role from profiles where id = auth.uid()) not in ('ouder','leerling'), false);
$$;

-- Leerling ziet eigen record (students.profile_id = auth.uid()); ouder ziet
-- de leerling(en) waar hij/zij als guardian aan gekoppeld staat. Wordt per
-- module (Fase 1+) gebruikt om ouder/leerling-select-policies op te bouwen,
-- i.p.v. voor elke tabel een eigen dubbele exists-subquery te herhalen.
create or replace function is_own_student(p_student_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from students s where s.student_id = p_student_id and s.profile_id = auth.uid()
  ) or exists (
    select 1 from students s
    join student_guardians sg on sg.student_id = s.student_id
    join guardians g on g.guardian_id = sg.guardian_id
    where s.student_id = p_student_id and g.profile_id = auth.uid()
  );
$$;

-- === RLS inschakelen ============================================================

alter table schools enable row level security;
alter table school_settings enable row level security;
alter table profiles enable row level security;
alter table classes enable row level security;
alter table subjects enable row level security;
alter table students enable row level security;
alter table guardians enable row level security;
alter table student_guardians enable row level security;
alter table courses enable row level security;
alter table tests enable row level security;
alter table makeup_slots enable row level security;
alter table test_documents enable row level security;
alter table missed_tests enable row level security;
alter table makeup_tests enable row level security;
alter table attendance_events enable row level security;
alter table interventions enable row level security;
alter table maatwerk_slots enable row level security;
alter table maatwerk_assignments enable row level security;
alter table signals enable row level security;
alter table tasks enable row level security;
alter table communications enable row level security;
alter table conversations enable row level security;
alter table conversation_notes enable row level security;
alter table opp_plans enable row level security;
alter table opp_goals enable row level security;
alter table opp_actions enable row level security;
alter table dossier_entries enable row level security;
alter table audit_logs enable row level security;
alter table integrations enable row level security;
alter table imports enable row level security;
alter table notification_templates enable row level security;

-- schools/profiles: eigen school zien, profiel zelf bijwerken.
create policy schools_select on schools for select
  using (school_id = current_school_id());
create policy profiles_select on profiles for select
  using (school_id = current_school_id());
create policy profiles_update_self on profiles for update
  using (id = auth.uid());

-- Generieke staff-policy: personeelsrollen (alles behalve ouder/leerling)
-- krijgen volledige CRUD binnen hun eigen school, op elke procestabel.
-- Verfijning per rol (bv. alleen vakdocent maakt een toets aan) volgt per
-- module in de fase die de bijbehorende UI bouwt.
do $$
declare
  t text;
  -- conversation_notes/opp_goals/opp_actions bewust weggelaten: die hebben
  -- geen eigen school_id-kolom en krijgen hun eigen subquery-policy verderop.
  staff_tables text[] := array[
    'school_settings','classes','subjects','students','guardians','courses',
    'tests','makeup_slots','test_documents','missed_tests','makeup_tests',
    'attendance_events','interventions','maatwerk_slots','maatwerk_assignments',
    'signals','tasks','communications','conversations',
    'opp_plans','dossier_entries','audit_logs',
    'integrations','imports','notification_templates'
  ];
begin
  foreach t in array staff_tables loop
    execute format(
      'create policy %I_staff_select on %I for select using (school_id = current_school_id() and is_staff());',
      t, t
    );
    execute format(
      'create policy %I_staff_insert on %I for insert with check (school_id = current_school_id() and is_staff());',
      t, t
    );
    execute format(
      'create policy %I_staff_update on %I for update using (school_id = current_school_id() and is_staff());',
      t, t
    );
    execute format(
      'create policy %I_staff_delete on %I for delete using (school_id = current_school_id() and is_staff());',
      t, t
    );
  end loop;
end $$;

-- student_guardians/opp_goals/opp_actions/conversation_notes hebben geen
-- eigen school_id-kolom (leiden hun scope af van hun ouder-record) - los
-- afgehandeld met een subquery i.p.v. de generieke loop hierboven.
create policy student_guardians_staff on student_guardians for all
  using (is_staff() and exists (select 1 from students s where s.student_id = student_guardians.student_id and s.school_id = current_school_id()))
  with check (is_staff() and exists (select 1 from students s where s.student_id = student_guardians.student_id and s.school_id = current_school_id()));

create policy opp_goals_staff on opp_goals for all
  using (is_staff() and exists (select 1 from opp_plans p where p.opp_id = opp_goals.opp_id and p.school_id = current_school_id()))
  with check (is_staff() and exists (select 1 from opp_plans p where p.opp_id = opp_goals.opp_id and p.school_id = current_school_id()));

create policy opp_actions_staff on opp_actions for all
  using (is_staff() and exists (select 1 from opp_plans p where p.opp_id = opp_actions.opp_id and p.school_id = current_school_id()))
  with check (is_staff() and exists (select 1 from opp_plans p where p.opp_id = opp_actions.opp_id and p.school_id = current_school_id()));

create policy conversation_notes_staff on conversation_notes for all
  using (is_staff() and exists (select 1 from conversations c where c.conversation_id = conversation_notes.conversation_id and c.school_id = current_school_id()))
  with check (is_staff() and exists (select 1 from conversations c where c.conversation_id = conversation_notes.conversation_id and c.school_id = current_school_id()));

-- === Fase 1: ouder/leerling-zicht op eigen (kind-)gegevens ===================
-- Bewust read-only en smal: alleen wat leerling.html/dashboard-uitbreiding
-- nodig heeft. test_documents alleen zichtbaar zodra status='goedgekeurd'
-- (een leerling mag nooit een niet-goedgekeurde AI-conceptversie zien).

create policy students_own_select on students for select
  using (is_own_student(student_id));

create policy missed_tests_own_select on missed_tests for select
  using (is_own_student(student_id));

create policy makeup_tests_own_select on makeup_tests for select
  using (exists (select 1 from missed_tests mt where mt.missed_test_id = makeup_tests.missed_test_id and is_own_student(mt.student_id)));

create policy test_documents_own_select on test_documents for select
  using (exists (
    select 1 from makeup_tests mkt
    join missed_tests mt on mt.missed_test_id = mkt.missed_test_id
    where mkt.document_id = test_documents.document_id and is_own_student(mt.student_id) and test_documents.status = 'goedgekeurd'
  ));

-- === Fase 2: ouder/leerling-zicht op eigen verzuim/maatwerk ===================
-- signals blijft bewust buiten dit zicht (escalatie-detail is Fase 3-terrein).

create policy attendance_events_own_select on attendance_events for select
  using (is_own_student(student_id));

create policy interventions_own_select on interventions for select
  using (is_own_student(student_id));

create policy maatwerk_assignments_own_select on maatwerk_assignments for select
  using (is_own_student(student_id));

-- === Fase 3: ouder/leerling-zicht op oudergesprekken + communicatie ===========
-- signals en conversation_notes blijven bewust staff-only (escalatie-detail
-- resp. interne mentor-aantekeningen). Ouder mag een voorgesteld gesprek
-- NIET rechtstreeks via een update-policy bevestigen (RLS is rij-niveau,
-- geen kolom-niveau - dan zou een ouder ook scheduled_at/status/kind kunnen
-- wijzigen) - dat gaat via de edge function `bevestig-oudergesprek`.

create policy conversations_own_select on conversations for select
  using (is_own_student(student_id));

create policy communications_own_select on communications for select
  using (student_id is not null and is_own_student(student_id));
