// Kleine, afhankelijkheidsvrije UI-hulpfuncties die op elke pagina worden
// hergebruikt: formattering, toasts en wat DOM-shortcuts.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatDate(value) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function formatDateTime(value) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' +
    d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}

// Zet een lijst rijen om naar een CSV-bestand en start meteen de download -
// puntkomma als scheidingsteken (Nederlandse Excel-instelling verwacht dat)
// en een BOM zodat accenten (bijv. "ë") correct blijven staan.
export function downloadCsv(filename, headers, rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.map(esc).join(';'), ...rows.map((r) => r.map(esc).join(';'))];
  const csv = '﻿' + lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function initials(name) {
  if (!name) return '?';
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('');
}

// Dubbele bevestiging voor verwijderacties - een reflexmatige dubbele klik
// op "OK" doorloopt niet per ongeluk allebei de stappen omdat de tweede
// vraag bewust andersluidend is.
export function confirmDangerous(message) {
  if (!confirm(message)) return false;
  return confirm('Weet je het ZEKER? Dit kan niet ongedaan worden gemaakt.');
}

let toastTimer = null;
export function toast(message, tone = 'default') {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `toast toast--visible toast--${tone}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = 'toast';
  }, 3600);
}

export function setLoading(button, loading, loadingText = 'Bezig…') {
  if (!button) return;
  if (loading) {
    button.dataset.originalText = button.dataset.originalText || button.textContent;
    button.textContent = loadingText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

// Generieke kolomsortering voor tabellen. Zet data-sort="veldnaam" op een
// <th>; roep initSortableTable(theadEl, state, herteken) één keer aan bij het
// opzetten van de pagina.
export function initSortableTable(thead, state, onSortChange) {
  if (!thead) return;
  thead.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      state.dir = state.key === key && state.dir === 'asc' ? 'desc' : 'asc';
      state.key = key;
      thead.querySelectorAll('th[data-sort]').forEach((t2) => t2.classList.remove('sort-asc', 'sort-desc'));
      th.classList.add(state.dir === 'asc' ? 'sort-asc' : 'sort-desc');
      onSortChange();
    });
  });
}

export function sortRows(rows, state, accessors) {
  const get = state.key && accessors[state.key];
  if (!get) return rows;
  const sorted = [...rows].sort((a, b) => {
    const av = get(a);
    const bv = get(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string') return av.localeCompare(bv, 'nl', { sensitivity: 'base' });
    return av - bv;
  });
  return state.dir === 'desc' ? sorted.reverse() : sorted;
}

// Opent een schone, geformatteerde weergave in een nieuw tabblad en start
// meteen het browser-printvenster - dat printvenster heeft op elk
// besturingssysteem/browser altijd een "Opslaan als PDF"-optie naast de
// echte printers, dus dit dekt afdrukken/PDF-opslaan/naar de printer
// sturen zonder extra bibliotheek. Werkt op tekst uit een <textarea>
// (die zelf niet goed print door de scrollbare hoogte) door de tekst in
// gewone HTML te herschrijven.
export function printDocument(title, bodyText, meta = {}) {
  const win = window.open('', '_blank');
  if (!win) { alert('Kon geen nieuw venster openen - controleer of pop-ups voor deze site zijn geblokkeerd.'); return; }
  const metaHtml = Object.entries(meta)
    .filter(([, v]) => v)
    .map(([k, v]) => `<div class="meta-row"><strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}</div>`)
    .join('');
  win.document.write(`<!doctype html>
<html lang="nl"><head><meta charset="UTF-8" /><title>${escapeHtml(title)}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; max-width: 720px; margin: 40px auto; padding: 0 24px 60px; color: #1a1a1a; line-height: 1.6; }
  h1 { font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 1.4rem; margin: 0 0 6px; }
  .meta-row { font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 0.85rem; color: #555; margin-bottom: 2px; }
  .divider { border: none; border-top: 1px solid #ccc; margin: 16px 0 22px; }
  .body-text { white-space: pre-wrap; font-size: 1.02rem; }
  @media print { body { margin: 0; padding: 20px; } }
</style>
</head><body>
  <h1>${escapeHtml(title)}</h1>
  ${metaHtml}
  <hr class="divider" />
  <div class="body-text">${escapeHtml(bodyText || '(geen inhoud)')}</div>
</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
}

export function friendlyError(error) {
  if (!error) return 'Er ging iets mis.';
  const msg = error.message || String(error);
  if (msg.includes('Invalid login credentials')) return 'E-mailadres of wachtwoord is onjuist.';
  if (msg.includes('duplicate key value')) return 'Dit bestaat al.';
  if (msg.includes('violates foreign key constraint')) {
    if (/^(insert|update)/i.test(msg)) return 'Dit verwijst naar iets dat niet meer bestaat. Ververs de pagina en probeer het opnieuw.';
    return 'Dit kan niet verwijderd worden omdat het nog ergens in gebruik is.';
  }
  if (msg.includes('row-level security') || msg.includes('permission denied')) {
    return 'Je hebt geen rechten voor deze actie.';
  }
  return msg;
}

// --- lichte SVG-grafieken (geen externe library nodig) --------------------

// items: [{ label, value, color }]. Simpele verticale staafdiagram.
export function barChart(items, { height = 160, formatValue = (n) => String(n) } = {}) {
  if (!items.length) return '<p style="color:var(--text-muted);font-size:0.85rem;">Geen gegevens.</p>';
  const max = Math.max(1, ...items.map((i) => i.value));
  const w = Math.max(240, items.length * 62);
  const padB = 34;
  const plotH = height - padB - 14;
  const slot = (w - 20) / items.length;
  const barW = Math.min(40, slot * 0.6);
  const bars = items.map((it, i) => {
    const cx = 10 + slot * i + slot / 2;
    const h = Math.max(2, (it.value / max) * plotH);
    const y = 14 + (plotH - h);
    return `<g>
      <title>${escapeHtml(it.label)}: ${escapeHtml(formatValue(it.value))}</title>
      <rect x="${(cx - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${it.color || 'var(--accent)'}" />
      <text x="${cx.toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" font-size="11" fill="var(--text)">${escapeHtml(formatValue(it.value))}</text>
      <text x="${cx.toFixed(1)}" y="${height - 10}" text-anchor="middle" font-size="10.5" fill="var(--text-muted)">${escapeHtml(it.label)}</text>
    </g>`;
  }).join('');
  // Bij veel items (bv. tientallen vakken/docenten) NIET platdrukken tot
  // onleesbaar door de SVG op 100% breedte te forceren - de grafiek houdt
  // zijn natuurlijke, leesbare breedte aan en de omringende div scrollt
  // horizontaal, zelfde patroon als brede tabellen (.table-wrap).
  return `<div style="overflow-x:auto;min-width:0;"><svg viewBox="0 0 ${w} ${height}" style="width:${w}px;height:${height}px;display:block;" role="img">${bars}</svg></div>`;
}

// Vult de topbar (naam, rol, uitlog-knop) die op elk dashboard hetzelfde is.
export function renderTopbar(profile, roleLabel, signOutFn) {
  const nameEl = $('#topbar-name');
  const roleEl = $('#topbar-role');
  const avatarEl = $('#topbar-avatar');
  if (nameEl) nameEl.textContent = profile.full_name;
  if (roleEl) roleEl.textContent = roleLabel;
  if (avatarEl) avatarEl.textContent = initials(profile.full_name);
  const signOutBtn = $('#signout-btn');
  if (signOutBtn) signOutBtn.addEventListener('click', signOutFn);
  const menuBtn = $('#menu-toggle');
  const sidebar = $('#sidebar');
  if (menuBtn && sidebar) {
    menuBtn.addEventListener('click', () => sidebar.classList.toggle('sidebar--open'));
  }
}
