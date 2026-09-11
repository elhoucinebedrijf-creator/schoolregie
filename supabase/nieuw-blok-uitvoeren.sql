-- Plak dit hele bestand in de Supabase SQL Editor van het schoolregie-project
-- en klik op "Run". Dit is exact hetzelfde blok als het "-- NIEUW"-gedeelte
-- onderaan supabase/schema.sql — los bestand puur voor het gemak.
-- ============================================================================
-- NIEUW — dit blok kan veilig opnieuw uitgevoerd worden op een bestaand,
-- al gedeployed Supabase-project (alles hieronder gebruikt `if not exists`/
-- `create or replace`, zelfde conventie als de rest van dit bestand). Voegt
-- toe: rate limiting voor edge functions, een generieke statusgeschiedenis
-- (audit-trail per status-overgang) en archivering (AVG).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- rate_limit_hits — vaste-window teller, gebruikt door edge functions
-- (service-role client) voor rate limiting op de publieke
-- bevestigingsfuncties en de overige edge functions.
-- ---------------------------------------------------------------------------
create table if not exists rate_limit_hits (
  id uuid primary key default gen_random_uuid(),
  bucket_key text not null,
  window_start timestamptz not null,
  hit_count integer not null default 1,
  created_at timestamptz not null default now(),
  unique (bucket_key, window_start)
);
create index if not exists idx_rate_limit_hits_bucket_window on rate_limit_hits(bucket_key, window_start);

-- RLS zonder policies: weigert alle toegang voor anon/authenticated, alleen
-- de service-role client (in de edge functions) kan erbij.
alter table rate_limit_hits enable row level security;

create or replace function increment_rate_limit_hit(
  p_bucket_key text,
  p_window_start timestamptz
)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_count integer;
begin
  insert into rate_limit_hits (bucket_key, window_start, hit_count)
  values (p_bucket_key, p_window_start, 1)
  on conflict (bucket_key, window_start)
  do update set hit_count = rate_limit_hits.hit_count + 1
  returning hit_count into v_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- status_history — generieke audit-trail per status-overgang. De
-- "statusmachine" die dit product beschrijft was tot nu toe alleen een
-- huidige-waarde-kolom (`status text`) per tabel; dit legt elke overgang
-- vast (wie, wanneer, van-naar), zonder per tabel een eigen historietabel
-- te hoeven bouwen.
-- ---------------------------------------------------------------------------
create table if not exists status_history (
  history_id uuid primary key default gen_random_uuid(),
  school_id uuid references schools(school_id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  from_status text,
  to_status text not null,
  changed_by uuid references profiles(id) on delete set null,
  changed_at timestamptz not null default now()
);
create index if not exists idx_status_history_entity on status_history(entity_type, entity_id);
create index if not exists idx_status_history_school on status_history(school_id);

alter table status_history enable row level security;

create policy status_history_staff_select on status_history for select
  using (school_id = current_school_id() and is_staff());

-- TG_ARGV[0] = de PK-kolomnaam van de brontabel (varieert per tabel, bv.
-- 'missed_test_id') - zo hoeft deze functie niet per tabel herschreven te
-- worden. security definer zodat dit werkt ongeacht de RLS-rechten van de
-- gebruiker die de status wijzigt (die heeft toegang tot de brontabel,
-- maar hoeft geen aparte insert-recht op status_history te hebben).
create or replace function log_status_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_entity_id uuid;
  v_school_id uuid;
  v_row jsonb := to_jsonb(new);
begin
  v_entity_id := (v_row ->> TG_ARGV[0])::uuid;
  v_school_id := case when v_row ? 'school_id' then (v_row ->> 'school_id')::uuid else null end;

  if TG_OP = 'INSERT' then
    insert into status_history (school_id, entity_type, entity_id, from_status, to_status, changed_by)
    values (v_school_id, TG_TABLE_NAME, v_entity_id, null, new.status, auth.uid());
  elsif TG_OP = 'UPDATE' and new.status is distinct from old.status then
    insert into status_history (school_id, entity_type, entity_id, from_status, to_status, changed_by)
    values (v_school_id, TG_TABLE_NAME, v_entity_id, old.status, new.status, auth.uid());
  end if;

  return new;
end;
$$;

-- Toegepast op de 12 tabellen met een echte proces-"statusmachine"
-- (integrations/imports/communications bewust overgeslagen: dat is
-- technische/operationele status, geen onderdeel van het proces dat een
-- school volgt tot afronding).
do $$
declare
  t record;
  status_tables text[][] := array[
    ['test_documents', 'document_id'],
    ['missed_tests', 'missed_test_id'],
    ['makeup_tests', 'makeup_test_id'],
    ['interventions', 'intervention_id'],
    ['maatwerk_assignments', 'assignment_id'],
    ['signals', 'signal_id'],
    ['tasks', 'task_id'],
    ['conversations', 'conversation_id'],
    ['opp_plans', 'opp_id'],
    ['opp_goals', 'goal_id'],
    ['opp_actions', 'opp_action_id'],
    ['opp_signatures', 'signature_id']
  ];
  pair text[];
begin
  foreach pair slice 1 in array status_tables loop
    execute format('drop trigger if exists trg_status_history on %I;', pair[1]);
    execute format(
      'create trigger trg_status_history after insert or update on %I for each row execute function log_status_change(%L);',
      pair[1], pair[2]
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Archivering (AVG): bewust geen automatische verwijder-cronjob - een
-- school moet zelf een bewaartermijn-besluit nemen, en onomkeerbaar
-- automatisch wissen van leerlingdata mag niet zonder expliciete, actieve
-- instemming gebeuren. Dit voegt alleen de infrastructuur toe: een
-- instelbare bewaartermijn en een archief-vlag die records uit de
-- reguliere lijstweergaven filtert (zie beheer.html) zonder ze te
-- verwijderen. Definitieve verwijdering blijft een aparte, nog bewustere
-- vervolgstap.
-- ---------------------------------------------------------------------------
alter table school_settings add column if not exists retention_years int;

alter table students add column if not exists archived_at timestamptz;
alter table guardians add column if not exists archived_at timestamptz;
create index if not exists idx_students_archived on students(archived_at) where archived_at is not null;
create index if not exists idx_guardians_archived on guardians(archived_at) where archived_at is not null;

-- ============================================================================
-- Einde nieuw blok.
-- ============================================================================
