<?php
// Upload endpoint for the Predigt-Schnitt web app (planning doc §6.2).
// Copy to the web space, set the constants below, and enter the URL + token
// in the app under "Einstellungen → Upload-Ziele".

// ---- Konfiguration ----
const UPLOAD_TOKEN    = 'HIER-LANGEN-ZUFALLSTOKEN-EINTRAGEN'; // 40+ Zeichen, z. B. `openssl rand -hex 24`
const ALLOWED_ORIGINS = ['https://DEIN-NAME.github.io', 'http://localhost:5173', 'http://localhost:4173'];
const TARGET_DIR      = __DIR__ . '/../predigten/';
const MAX_BYTES       = 80 * 1024 * 1024;

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, ALLOWED_ORIGINS, true)) {
  header('Access-Control-Allow-Origin: ' . $origin);
  header('Vary: Origin');
}
header('Access-Control-Allow-Headers: X-Upload-Token');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Max-Age: 600');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }
if ($_SERVER['REQUEST_METHOD'] !== 'POST')    { http_response_code(405); exit('method not allowed'); }

if (UPLOAD_TOKEN === 'HIER-LANGEN-ZUFALLSTOKEN-EINTRAGEN') { http_response_code(500); exit('token not configured'); }
// Own header, because "Authorization" is swallowed by some (CGI) hosters
if (!hash_equals(UPLOAD_TOKEN, $_SERVER['HTTP_X_UPLOAD_TOKEN'] ?? '')) {
  http_response_code(401); exit('unauthorized');
}

$f = $_FILES['file'] ?? null;
if (!$f || $f['error'] !== UPLOAD_ERR_OK) {
  $tooBig = $f && in_array($f['error'], [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true);
  http_response_code($tooBig ? 413 : 400); exit($tooBig ? 'too large' : 'upload error');
}
if ($f['size'] > MAX_BYTES) { http_response_code(413); exit('too large'); }

$name = basename($f['name']);
if (!preg_match('/^[A-Za-z0-9._-]{1,120}\.mp3$/', $name)) { http_response_code(400); exit('bad name'); }

// Content check by magic bytes: ID3 tag or MPEG frame sync
$head = (string) file_get_contents($f['tmp_name'], false, null, 0, 3);
$isMp3 = $head === 'ID3' || (strlen($head) >= 2 && ord($head[0]) === 0xFF && (ord($head[1]) & 0xE0) === 0xE0);
if (!$isMp3) { http_response_code(415); exit('not mp3'); }

if (!is_dir(TARGET_DIR)) mkdir(TARGET_DIR, 0755, true);
$dest = TARGET_DIR . $name;
if (file_exists($dest)) { http_response_code(409); exit('exists'); }

if (!move_uploaded_file($f['tmp_name'], $dest)) { http_response_code(500); exit('move failed'); }
chmod($dest, 0644);
header('Content-Type: application/json');
echo json_encode(['ok' => true, 'file' => $name]);
