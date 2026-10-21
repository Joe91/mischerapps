<?php
// Shared storage for the Termine app: who can serve on which Sunday (Ja / Vielleicht / Nein),
// who is assigned, and notes per date. Data is kept in one JSON file next to this script.
// Same rules as apps/termine/src/model.ts – keep both in sync.
//
// Copy to the web space, set the constants below, and enter the URL + token
// in the app under "Einstellungen".

// ---- Konfiguration ----
const TERMINE_TOKEN   = 'HIER-LANGEN-ZUFALLSTOKEN-EINTRAGEN'; // 40+ Zeichen, z. B. `openssl rand -hex 24`
const ALLOWED_ORIGINS = ['https://DEIN-NAME.github.io', 'http://localhost:5173', 'http://localhost:4173'];
const DATA_DIR        = __DIR__ . '/termine-daten/';

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, ALLOWED_ORIGINS, true)) {
  header('Access-Control-Allow-Origin: ' . $origin);
  header('Vary: Origin');
}
header('Access-Control-Allow-Headers: X-Termine-Token, Content-Type');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Max-Age: 600');
header('Cache-Control: no-store');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

function fail(int $code, string $msg) { http_response_code($code); exit($msg); }

if (TERMINE_TOKEN === 'HIER-LANGEN-ZUFALLSTOKEN-EINTRAGEN') fail(500, 'token not configured');
if (!hash_equals(TERMINE_TOKEN, $_SERVER['HTTP_X_TERMINE_TOKEN'] ?? '')) fail(401, 'unauthorized');

$method = $_SERVER['REQUEST_METHOD'];
if ($method !== 'GET' && $method !== 'POST') fail(405, 'method not allowed');

if (!is_dir(DATA_DIR)) {
  mkdir(DATA_DIR, 0755, true);
  file_put_contents(DATA_DIR . '.htaccess', "Require all denied\n");
}

// One lock for read-modify-write, so simultaneous votes do not overwrite each other
$fh = fopen(DATA_DIR . 'termine.json', 'c+');
if (!$fh) fail(500, 'cannot open data file');
flock($fh, $method === 'POST' ? LOCK_EX : LOCK_SH);
$raw = stream_get_contents($fh);
$data = $raw ? json_decode($raw, true) : null;
if (!is_array($data) || !is_array($data['dates'] ?? null)) $data = ['dates' => []];

function valid_date($s): bool {
  return is_string($s) && preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $s, $m) && checkdate((int) $m[2], (int) $m[3], (int) $m[1]);
}
function text($v, int $max): string { return mb_substr(trim((string) $v), 0, $max); }

if ($method === 'POST') {
  $op = json_decode((string) file_get_contents('php://input'), true);
  if (!is_array($op) || !valid_date($op['date'] ?? null)) fail(400, 'bad date');
  $date = $op['date'];
  $entry = $data['dates'][$date] ?? ['title' => '', 'time' => '', 'assigned' => '', 'note' => '', 'votes' => []];
  if (!is_array($entry['votes'] ?? null)) $entry['votes'] = [];

  switch ($op['action'] ?? '') {
    case 'vote':
      $sign = mb_strtoupper(trim((string) ($op['sign'] ?? '')));
      if (!preg_match('/^[\p{L}\p{N}]{1,6}$/u', $sign)) fail(400, 'bad sign');
      $answer = $op['answer'] ?? null;
      if ($answer === null) unset($entry['votes'][$sign]);
      elseif (in_array($answer, ['yes', 'maybe', 'no'], true)) $entry['votes'][$sign] = $answer;
      else fail(400, 'bad answer');
      break;
    case 'update':
      foreach (['title' => 100, 'time' => 20, 'assigned' => 60, 'note' => 1000] as $k => $max) {
        $entry[$k] = text($op[$k] ?? '', $max);
      }
      break;
    default:
      fail(400, 'bad action');
  }

  $blank = $entry['title'] === '' && $entry['time'] === '' && $entry['assigned'] === '' && $entry['note'] === '' && !$entry['votes'];
  if ($blank) unset($data['dates'][$date]);
  else $data['dates'][$date] = $entry;
  ksort($data['dates']);

  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
  fflush($fh);
}
flock($fh, LOCK_UN);
fclose($fh);

// Empty vote maps must stay JSON objects, not []
foreach ($data['dates'] as &$e) $e['votes'] = (object) ($e['votes'] ?? []);
unset($e);
header('Content-Type: application/json; charset=utf-8');
echo json_encode(['dates' => (object) $data['dates']], JSON_UNESCAPED_UNICODE);
