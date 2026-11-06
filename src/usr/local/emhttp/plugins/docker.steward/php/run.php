<?PHP
/* GET            -> current/last update run (or null)
 * POST names[]   -> start a run (refused while another is active)
 * POST dismiss=1 -> forget a finished run */
$docroot ??= ($_SERVER['DOCUMENT_ROOT'] ?: '/usr/local/emhttp');
require_once "$docroot/plugins/docker.steward/php/lib.php";

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') stw_reply(['run' => stw_run_state()]);

if (!empty($_POST['dismiss'])) {
  if (!stw_run_active()) @unlink(STW_RUN);
  stw_reply(['run' => null]);
}

if (!stw_compat()['updates']) stw_reply(['ok' => false, 'code' => 'unsupported'], 503);
$want = $_POST['names'] ?? [];
if (!is_array($want) || !$want || count($want) > 200) stw_reply(['ok' => false, 'code' => 'bad_names'], 400);
foreach ($want as $n) if (!stw_valid_name($n)) stw_reply(['ok' => false, 'code' => 'bad_name'], 400);

// Keep the stock priority order, and only accept containers update_container can handle.
$info  = (new DockerTemplates())->getAllInfo();
$items = [];
foreach (stw_containers() as $c) {
  if (!in_array($c['Name'], $want, true)) continue;
  if (($c['Manager'] ?: '') !== 'dockerman' || empty($info[$c['Name']]['template'])) continue;
  $items[] = ['name' => $c['Name'], 'state' => 'queued', 'from' => (string)$c['Id']];
}
if (!$items) stw_reply(['ok' => false, 'code' => 'nothing'], 400);

// Check-and-start under one lock so two simultaneous clicks cannot start two workers.
stw_tmp();
$lock = @fopen(STW_RUNLOCK, 'c');
if (!$lock || !flock($lock, LOCK_EX)) stw_reply(['ok' => false, 'code' => 'lock'], 500);
if (stw_run_active()) stw_reply(['ok' => false, 'code' => 'busy'], 409);
stw_run_write(['id' => bin2hex(random_bytes(4)), 'started' => time(), 'finished' => 0, 'pid' => 0, 'items' => $items]);
$worker = escapeshellarg(__DIR__ . '/worker.php');
$php = is_executable('/usr/bin/php') ? '/usr/bin/php' : 'php';
exec("nohup $php $worker >/dev/null 2>&1 &");
flock($lock, LOCK_UN);
stw_reply(['ok' => true, 'run' => stw_run_state()]);
