// Schrijft een audit-event weg op de RLS-scoped client van de aanroeper
// (dus als de ingelogde gebruiker zelf) - audit_logs heeft al brede
// staff-insert-rechten binnen de eigen school (zie de generieke
// staff-policy-loop in supabase/schema.sql), dus dit werkt zonder verdere
// RLS-wijziging. Voor UI-directe kritieke acties die niet via een edge
// function lopen (die loggen zelf al server-side, bv.
// beheer-account-aanmaken). Fouten hierbij blokkeren nooit de eigenlijke
// actie: audit logging is aanvullend, niet kritiek voor de flow.
export async function logAudit(supabase, { schoolId, actorProfileId, action, entityType, entityId, detail }) {
  const { error } = await supabase.from('audit_logs').insert({
    school_id: schoolId,
    actor_profile_id: actorProfileId,
    action,
    entity_type: entityType,
    entity_id: entityId ?? null,
    detail: detail ?? null,
  });
  if (error) console.error('Audit log schrijven mislukt:', error.message);
}
