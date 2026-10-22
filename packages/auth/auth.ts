// Login against the server (cookie session, see server/api.ts). Two roles:
//   admin   – sets up dates, shared settings, import/export
//   mischer – answers dates, cuts and uploads sermons
// The role only decides what the UI shows; the server checks every request itself.
import { h } from '../ui-kit/dom';

export type Role = 'admin' | 'mischer';
export interface Session { user: string; role: Role; }

let current: Session | null = null;
export const session = () => current;
export const isAdmin = () => current?.role === 'admin';

async function fetchSession(): Promise<Session | null> {
  const res = await fetch('/api/me', { cache: 'no-store' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Server-Antwort ${res.status}`);
  return res.json();
}

export async function logout() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch { /* the cookie expires anyway */ }
  location.reload();
}

/**
 * Resolves with the session once the user is logged in; shows the login form if necessary: covering the page,
 * or inside `host` so that the page stays visible (the home page shows the Einsatzplan to visitors).
 */
export async function ensureLogin(appTitle = 'Mischer-Apps', host?: HTMLElement): Promise<Session> {
  for (;;) {
    try {
      current = await fetchSession() ?? await askForLogin(appTitle, host);
      break;
    } catch {
      await showOffline();
    }
  }
  document.body.dataset.role = current.role;
  const out = document.getElementById('logout');
  if (out) out.title = `Angemeldet als ${current.user}`;
  return current;
}

function showOffline(): Promise<void> {
  return new Promise(resolve => {
    const overlay = h('div', { class: 'login-overlay' }, h('div', { class: 'login-card' },
      h('h1', null, 'Server nicht erreichbar'),
      h('p', { class: 'muted' }, 'Bitte die Internetverbindung prüfen und noch einmal versuchen.'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { overlay.remove(); resolve(); } }, 'Erneut versuchen'),
    ));
    document.body.append(overlay);
  });
}

function askForLogin(appTitle: string, host?: HTMLElement): Promise<Session> {
  return new Promise(resolve => {
    const err = h('p', { class: 'login-error', role: 'alert' });
    const user = h('input', { name: 'username', autocomplete: 'username', required: true, autocapitalize: 'off', spellcheck: 'false' });
    const pass = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Anmelden');
    const form = h('form', {
      class: 'login-card',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        submit.disabled = true;
        err.textContent = '';
        try {
          const res = await fetch('/api/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user: user.value, password: pass.value }),
          });
          if (res.ok) { overlay.remove(); resolve(await res.json()); return; }
          err.textContent = res.status === 429
            ? 'Zu viele Versuche. Bitte später noch einmal probieren.'
            : 'Benutzername oder Passwort falsch.';
          pass.select();
        } catch {
          err.textContent = 'Server nicht erreichbar.';
        } finally {
          submit.disabled = false;
        }
      },
    },
      h('h1', null, appTitle),
      h('p', { class: 'muted' }, 'Bitte anmelden. Die Anmeldung bleibt in diesem Browser erhalten.'),
      h('label', null, 'Benutzer', user),
      h('label', null, 'Passwort', pass),
      err,
      submit,
    );
    const overlay = host ? form : h('div', { class: 'login-overlay' }, form);
    if (host) host.append(form);
    else { document.body.append(overlay); user.focus(); } // inline: no focus, the keyboard would cover the page on phones
  });
}
