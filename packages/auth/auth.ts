// Simple login gate for all apps of this site. The login is remembered in localStorage.
//
// Note: on a static site this is a convenience barrier, not access control – the
// credentials are part of the shipped JavaScript. Real protection of the uploads comes
// from the upload token checked on the target server.
import { h } from '../ui-kit/dom';

const USER = 'mischer';
const PASS = 'mischer';
const KEY = 'audio-tools.auth';

export function isLoggedIn(): boolean {
  try { return localStorage.getItem(KEY) === USER; } catch { return false; }
}

export function logout() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  location.reload();
}

/** Resolves once the user is logged in; shows the login form if necessary. */
export function ensureLogin(appTitle = 'Audio-Werkzeuge'): Promise<void> {
  if (isLoggedIn()) return Promise.resolve();
  return new Promise(resolve => {
    const err = h('p', { class: 'login-error', role: 'alert' });
    const user = h('input', { name: 'username', autocomplete: 'username', required: true, autocapitalize: 'off', spellcheck: 'false' });
    const pass = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
    const form = h('form', {
      class: 'login-card',
      onsubmit: (e: Event) => {
        e.preventDefault();
        if (user.value.trim().toLowerCase() === USER && pass.value === PASS) {
          try { localStorage.setItem(KEY, USER); } catch { /* login then lasts for this page only */ }
          overlay.remove();
          resolve();
        } else {
          err.textContent = 'Benutzername oder Passwort falsch.';
          pass.select();
        }
      },
    },
      h('h1', null, appTitle),
      h('p', { class: 'muted' }, 'Bitte anmelden. Die Anmeldung bleibt in diesem Browser gespeichert.'),
      h('label', null, 'Benutzer', user),
      h('label', null, 'Passwort', pass),
      err,
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Anmelden'),
    );
    const overlay = h('div', { class: 'login-overlay' }, form);
    document.body.append(overlay);
    user.focus();
  });
}
