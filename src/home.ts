import '../packages/ui-kit/ui.css';
import './home.css';
import apps from '../apps.json';
import { ensureLogin, logout } from '../packages/auth/auth';
import { h, $ } from '../packages/ui-kit/dom';

interface AppEntry { id: string; title: string; description: string; path: string; icon: string; }

$('#logout').addEventListener('click', logout);
await ensureLogin();
$('#tiles').append(...(apps as AppEntry[]).map(a =>
  h('a', { class: 'tile', href: a.path },
    h('span', { class: 'tile-icon', 'aria-hidden': 'true' }, a.icon),
    h('span', { class: 'tile-title' }, a.title),
    h('span', { class: 'tile-desc' }, a.description),
  ),
));
