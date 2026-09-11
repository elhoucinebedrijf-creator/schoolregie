// Data-/authenticatielaag: één Supabase-client voor de hele site.
// Vastgezet op een exacte versie tegen supply-chain-risico - zie de
// toelichting in de andere producten van dit traject.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.115.0/+esm';

const cfg = window.SUPABASE_CONFIG || {};
const PLACEHOLDER_MARKERS = ['JOUW-PROJECT', 'JOUW-ANON-KEY'];
const notConfigured = !cfg.url || !cfg.anonKey || PLACEHOLDER_MARKERS.some((m) => cfg.url.includes(m) || cfg.anonKey.includes(m));

if (notConfigured) {
  console.warn('[schoolregie] assets/config.js is nog niet ingevuld met je eigen Supabase-project.');
}

export const isConfigured = !notConfigured;

export const supabase = createClient(
  notConfigured ? 'https://placeholder.supabase.co' : cfg.url,
  notConfigured ? 'placeholder' : cfg.anonKey,
  { auth: { persistSession: true, autoRefreshToken: true } }
);

// De 11 rollen uit de spec.
// MFA (TOTP) is verplicht voor administrator/directie - zie requireUser()
// hieronder. Andere rollen kunnen 2FA optioneel instellen via profiel.html.
const MFA_VERPLICHTE_ROLLEN = ['administrator', 'directie'];
export const ROLE_HOME = {
  administrator: '/dashboard.html',
  directie: '/dashboard.html',
  teamleider: '/dashboard.html',
  mentor: '/dashboard.html',
  vakdocent: '/dashboard.html',
  surveillant: '/dashboard.html',
  verzuimcoordinator: '/dashboard.html',
  zorgcoordinator: '/dashboard.html',
  kwaliteitsmedewerker: '/dashboard.html',
  ouder: '/dashboard.html',
  leerling: '/dashboard.html',
};

export const ROLE_LABEL = {
  administrator: 'Administrator',
  directie: 'Directie',
  teamleider: 'Teamleider',
  mentor: 'Mentor',
  vakdocent: 'Vakdocent',
  surveillant: 'Surveillant',
  verzuimcoordinator: 'Verzuimcoördinator',
  zorgcoordinator: 'Zorgcoördinator',
  kwaliteitsmedewerker: 'Kwaliteitsmedewerker',
  ouder: 'Ouder/verzorger',
  leerling: 'Leerling',
};

export async function getSessionProfile() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { session: null, profile: null };
  const { data: profile, error } = await supabase.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
  if (error || !profile) return { session, profile: null };
  return { session, profile };
}

// Vereist een ingelogde gebruiker, optioneel beperkt tot een lijst rollen.
export async function requireUser(allowedRollen) {
  const { session, profile } = await getSessionProfile();
  if (!session) {
    window.location.href = '/login.html';
    return null;
  }
  if (!profile) {
    window.location.href = '/account-nog-niet-actief.html';
    return null;
  }
  if (allowedRollen && !allowedRollen.includes(profile.role)) {
    window.location.href = ROLE_HOME[profile.role] || '/login.html';
    return null;
  }

  if (MFA_VERPLICHTE_ROLLEN.includes(profile.role)) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    const isProfielPagina = window.location.pathname.endsWith('/profiel.html');

    // Sessie is blijven hangen tussen wachtwoord (AAL1) en de 2FA-code
    // (AAL2) - forceer een schone herlogin, die de MFA-stap in login.html
    // wél afdwingt.
    if (aal && aal.currentLevel === 'aal1' && aal.nextLevel === 'aal2') {
      await supabase.auth.signOut();
      window.location.href = '/login.html';
      return null;
    }

    // Geen enkele geverifieerde factor geregistreerd - verplicht naar
    // profiel.html om er een in te stellen, behalve als je daar al bent.
    if (aal && aal.nextLevel === 'aal1' && !isProfielPagina) {
      const { data: factors } = await supabase.auth.mfa.listFactors();
      const heeftGeverifieerdeFactor = (factors?.totp ?? []).some((f) => f.status === 'verified');
      if (!heeftGeverifieerdeFactor) {
        window.location.href = '/profiel.html?mfa_verplicht=1';
        return null;
      }
    }
  }

  return { session, profile, supabase };
}

export async function signOut() {
  await supabase.auth.signOut();
  window.location.href = '/login.html';
}

export async function invokeFunction(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    if (error.context?.json) {
      const parsed = await error.context.json().catch(() => null);
      if (parsed?.error) throw new Error(parsed.error);
    }
    throw error;
  }
  if (data?.error) throw new Error(data.error);
  return data;
}
