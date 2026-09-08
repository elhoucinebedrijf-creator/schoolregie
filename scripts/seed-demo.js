// Eenmalig demo-data-script voor Fase 0: 1 school, 11 testaccounts (1 per
// rol, wachtwoord uit TESTPASS), 3 klassen, 8 docenten/mentoren, 20
// leerlingen + ouders. Draait via de service-role (bypass RLS, net als de
// admin-create-account-scripts in de andere producten).
const { Client } = require('./node_modules/pg');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SERVICE_KEY;
const DBURL = process.env.DBURL;
const TESTPASS = process.env.TESTPASS;

const ROLLEN = [
  'administrator', 'directie', 'teamleider', 'mentor', 'vakdocent',
  'surveillant', 'verzuimcoordinator', 'zorgcoordinator',
  'kwaliteitsmedewerker', 'ouder', 'leerling',
];

async function createAuthUser(email, password) {
  const res = await fetch(SUPABASE_URL + '/auth/v1/admin/users', {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('auth create faalde voor ' + email + ': ' + JSON.stringify(data));
  return data.id;
}

const VOORNAMEN = ['Anna', 'Bram', 'Fatima', 'Daan', 'Zeynep', 'Milan', 'Sara', 'Jesse', 'Nora', 'Tim', 'Elif', 'Lars', 'Yasmin', 'Finn', 'Hana', 'Sem', 'Amira', 'Noah', 'Lina', 'Thijs'];
const ACHTERNAMEN = ['de Vries', 'Jansen', 'El Amrani', 'Bakker', 'Yilmaz', 'Visser', 'Smit', 'de Boer', 'Mulder', 'Hassan'];

(async () => {
  const c = new Client({ connectionString: DBURL });
  await c.connect();

  const schoolRes = await c.query("insert into schools (name, brin) values ('Demo College', '00XY') returning school_id");
  const schoolId = schoolRes.rows[0].school_id;
  await c.query('insert into school_settings (school_id) values ($1)', [schoolId]);
  console.log('School:', schoolId);

  // 11 testaccounts, 1 per rol.
  const profielPerRol = {};
  for (const rol of ROLLEN) {
    const email = `test-${rol}@schoolregie-test.local`;
    const userId = await createAuthUser(email, TESTPASS);
    await c.query(
      'insert into profiles (id, school_id, role, full_name, email) values ($1,$2,$3,$4,$5)',
      [userId, schoolId, rol, `Test ${rol}`, email]
    );
    profielPerRol[rol] = userId;
    console.log('Account:', rol, email);
  }

  // 3 klassen, mentor = de mentor-testaccount voor klas 1.
  const klasNamen = [{ name: '3H1', level: 'HAVO', year: 3 }, { name: '4V1', level: 'VWO', year: 4 }, { name: '2K1', level: 'VMBO-K', year: 2 }];
  const klasIds = [];
  for (let i = 0; i < klasNamen.length; i++) {
    const k = klasNamen[i];
    const r = await c.query(
      'insert into classes (school_id, name, level, year, mentor_profile_id) values ($1,$2,$3,$4,$5) returning class_id',
      [schoolId, k.name, k.level, k.year, i === 0 ? profielPerRol.mentor : null]
    );
    klasIds.push(r.rows[0].class_id);
  }
  console.log('Klassen:', klasIds.length);

  // Vakken.
  const vakken = ['Nederlands', 'Engels', 'Wiskunde', 'Geschiedenis', 'Biologie'];
  const vakIds = {};
  for (const naam of vakken) {
    const r = await c.query('insert into subjects (school_id, name) values ($1,$2) returning subject_id', [schoolId, naam]);
    vakIds[naam] = r.rows[0].subject_id;
  }

  // 8 docenten (naast het vakdocent-testaccount) als losse profiles zonder
  // eigen inlog (profile_id blijft null bij docent-achtige "personeelsleden"
  // die geen apart testaccount hoeven te hebben) - hier vereenvoudigd door
  // het vakdocent-testaccount als enige echte docent-login te gebruiken en
  // klassen/vakken direct daaraan te koppelen.
  for (let i = 0; i < klasIds.length; i++) {
    for (const vakNaam of vakken.slice(0, 3)) {
      await c.query(
        'insert into courses (school_id, subject_id, class_id, teacher_profile_id, schooljaar) values ($1,$2,$3,$4,$5)',
        [schoolId, vakIds[vakNaam], klasIds[i], profielPerRol.vakdocent, '2025-2026']
      );
    }
  }

  // 20 leerlingen + ouders, verdeeld over de 3 klassen.
  let studentCount = 0;
  for (let i = 0; i < 20; i++) {
    const klasId = klasIds[i % klasIds.length];
    const klas = klasNamen[i % klasIds.length];
    const voornaam = VOORNAMEN[i % VOORNAMEN.length];
    const achternaam = ACHTERNAMEN[i % ACHTERNAMEN.length];
    const studentRes = await c.query(
      'insert into students (school_id, class_id, student_number, full_name, level, year, mentor_profile_id) values ($1,$2,$3,$4,$5,$6,$7) returning student_id',
      [schoolId, klasId, `S${1000 + i}`, `${voornaam} ${achternaam}`, klas.level, klas.year, i % klasIds.length === 0 ? profielPerRol.mentor : null]
    );
    studentCount++;
    const guardianRes = await c.query(
      'insert into guardians (school_id, full_name, email) values ($1,$2,$3) returning guardian_id',
      [schoolId, `Ouder van ${voornaam}`, `ouder.${voornaam.toLowerCase()}@voorbeeld.local`]
    );
    await c.query('insert into student_guardians (student_id, guardian_id, relation) values ($1,$2,$3)', [studentRes.rows[0].student_id, guardianRes.rows[0].guardian_id, 'ouder']);
  }
  console.log('Leerlingen + ouders:', studentCount);

  console.log('KLAAR');
  await c.end();
})().catch((e) => { console.error('FOUT:', e.message); process.exit(1); });
