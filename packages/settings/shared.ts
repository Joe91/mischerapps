// Settings the admin sets for everybody, kept on the server (GET/PUT /api/settings/<app>).

export async function loadShared(app: string): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(`/api/settings/${app}`, { cache: 'no-store' });
    return res.ok ? await res.json() : {};
  } catch {
    return {}; // offline: the browser's own copy is used
  }
}

/** Admin only; the server rejects everybody else. */
export async function saveShared(app: string, values: unknown): Promise<void> {
  const res = await fetch(`/api/settings/${app}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values),
  });
  if (res.ok) return;
  if (res.status === 403) throw new Error('Nur der Admin darf die gemeinsamen Einstellungen ändern.');
  if ((await res.text()).includes('damaged')) {
    throw new Error('Die Datei settings.json auf dem NAS ist beschädigt und wird deshalb nicht überschrieben. Bitte reparieren oder löschen.');
  }
  throw new Error(`Speichern auf dem Server fehlgeschlagen (${res.status}).`);
}
