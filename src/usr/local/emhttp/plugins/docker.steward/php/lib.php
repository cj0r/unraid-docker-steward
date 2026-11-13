<?PHP
/* Docker Steward - shared PHP helpers.
 *
 * Only stock Unraid classes are used (DockerClient, DockerUpdate, DockerTemplates);
 * no core file is modified. Require this from file scope, never from inside a
 * function: DockerClient.php defines $dockerManPaths as a global.
 */
$docroot ??= ($_SERVER['DOCUMENT_ROOT'] ?: '/usr/local/emhttp');
// Guarded: if a future Unraid moves these files, stw_compat() reports it instead of a fatal error.
foreach (["$docroot/webGui/include/Helpers.php", "$docroot/plugins/dynamix.docker.manager/include/DockerClient.php"] as $f) {
  if (is_file($f)) require_once $f;
}

const STW_TMP   = '/tmp/docker.steward';   // RAM only: nothing here is worth a flash write
const STW_STATE = STW_TMP . '/checks.json';
const STW_LOCK  = STW_TMP . '/check.lock';
const STW_COMPAT = __DIR__ . '/../compat.json';   // shipped: minimum + Unraid versions this release was tested on
const STW_RUNLOCK = STW_TMP . '/run.lock';
const STW_RUN   = STW_TMP . '/run.json';
const STW_LOG   = STW_TMP . '/run.log';

/* ----------------------------------------------------------- compatibility
 * Everything this plugin takes from Unraid is checked here, once per page load,
 * so a future Unraid release that moves or renames something produces one clear
 * message instead of a broken page.
 *   level 'ok'       all present, running version is one this release was tested on
 *   level 'untested' all present, but this Unraid version is not in compat.json
 *   level 'degraded' list and checks work, updating cannot be started
 *   level 'broken'   the list itself cannot be built
 * Returns also 'lists' (bool) and 'updates' (bool) for the callers. */
function stw_unraid_version() {
  $f = '/etc/unraid-version';
  return is_file($f) && preg_match('/version="([^"]+)"/', (string)@file_get_contents($f), $m) ? $m[1] : '';
}

function stw_compat() {
  static $cache = null;
  if ($cache !== null) return $cache;
  global $docroot, $dockerManPaths;
  $meta  = is_file(STW_COMPAT) ? (json_decode((string)@file_get_contents(STW_COMPAT), true) ?: []) : [];
  $tested = array_values((array)($meta['tested'] ?? []));
  $min    = (string)($meta['min'] ?? '7.0.0');
  $ver    = stw_unraid_version();
  $list = []; $upd = [];                       // problems that break the list / only updating

  foreach (['DockerClient', 'DockerTemplates', 'DockerUpdate', 'DockerUtil'] as $c) {
    if (!class_exists($c)) $list[] = "Unraid class $c is missing";
  }
  if (!$list) {
    foreach ([['DockerClient', 'getDockerContainers'], ['DockerTemplates', 'getAllInfo'], ['DockerUpdate', 'reloadUpdateStatus'], ['DockerUpdate', 'getUpdateStatus'],
              ['DockerUtil', 'loadJSON'], ['DockerUtil', 'saveJSON'], ['DockerUtil', 'ensureImageTag']] as [$c, $m]) {
      if (!method_exists($c, $m)) $list[] = "$c::$m() is missing";
    }
    foreach (['update-status', 'user-prefs'] as $k) {
      if (empty($dockerManPaths[$k])) $list[] = "Unraid path setting '$k' is missing";
    }
  }
  if (!$list) {
    try {
      $first = (new DockerClient())->getDockerContainers()[0] ?? null;
      if ($first !== null) foreach (['Name', 'Image', 'Id', 'Running', 'Paused'] as $k) {
        if (!array_key_exists($k, $first)) $list[] = "container data no longer has '$k'";
      }
    } catch (Throwable $e) { $list[] = 'reading containers failed: ' . $e->getMessage(); }
  }
  // Start/stop/pause/restart go through Unraid's own Events.php and DockerClient; if either is missing the menu simply omits them.
  $actions = is_file("$docroot/plugins/dynamix.docker.manager/include/Events.php") && !$list;
  if ($actions) foreach (['startContainer', 'stopContainer', 'restartContainer', 'pauseContainer', 'resumeContainer'] as $m) {
    if (!method_exists('DockerClient', $m)) $actions = false;
  }
  if (!is_executable("$docroot/plugins/dynamix.docker.manager/scripts/update_container")) $upd[] = 'Unraid\'s update_container script was not found';
  if ($ver !== '' && version_compare($ver, $min, '<')) $upd[] = "Unraid $ver is older than the supported minimum $min";

  $level = $list ? 'broken' : ($upd ? 'degraded' : (($ver !== '' && !in_array($ver, $tested, true)) ? 'untested' : 'ok'));
  return $cache = [
    'level' => $level, 'problems' => array_merge($list, $upd),
    'lists' => !$list, 'updates' => !$list && !$upd, 'actions' => $actions,
    'unraid' => $ver, 'tested' => $tested, 'min' => $min,
  ];
}

function stw_tmp() {
  if (is_link(STW_TMP)) @unlink(STW_TMP);              // never follow a planted symlink
  if (!is_dir(STW_TMP)) @mkdir(STW_TMP, 0700, true);
  @chmod(STW_TMP, 0700);
}

function stw_reply($data, $code = 200) {
  http_response_code($code);
  header('Content-Type: application/json');
  header('Cache-Control: no-store');
  header('X-Content-Type-Options: nosniff');
  echo json_encode($data);
  exit;
}

function stw_valid_name($name) {
  return is_string($name) && preg_match('/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/D', $name) === 1;   // D: '$' must not match before a trailing newline
}

function stw_digest($d) {
  $d = str_replace('sha256:', '', (string)$d);
  return substr($d, 0, 12);
}

/* Containers in the order of the stock Docker page (the user's drag-and-drop
 * priority), which is also the order updates are applied in. */
function stw_containers() {
  global $dockerManPaths;
  $list = (new DockerClient())->getDockerContainers();
  if (is_file($dockerManPaths['user-prefs'])) {
    $prefs = (array)@parse_ini_file($dockerManPaths['user-prefs']);
    $keys = [];
    foreach ($list as $c) {
      $p = array_search($c['Name'], $prefs);
      $keys[] = $p === false ? PHP_INT_MAX : $p;
    }
    array_multisort($keys, SORT_NUMERIC, $list);
  }
  return $list;
}

/* ------------------------------------------------------------ check times
 * The stock update-status file has a single mtime for every image. To show
 * "checked 5 min ago" per row, remember our own single-image checks in
 * checks.json together with the mtime of the status file right after we wrote
 * it ('after'). If the mtime differs from 'after', somebody else (cron, the stock
 * button) rewrote the file and our notes are stale, so they are dropped.
 * 'base' is the mtime from before our first write = the last full check. */
function stw_mtime() {
  global $dockerManPaths;
  clearstatcache(true, $dockerManPaths['update-status']);
  return (int)@filemtime($dockerManPaths['update-status']);
}

function stw_notes() {
  $n = is_file(STW_STATE) ? json_decode((string)@file_get_contents(STW_STATE), true) : null;
  $mt = stw_mtime();
  if (!is_array($n) || (int)($n['after'] ?? -1) !== $mt) return ['base' => $mt, 'after' => -1, 'at' => []];
  return $n;
}

/* --------------------------------------------------------------- snapshot */
function stw_snapshot() {
  global $dockerManPaths;
  $compat = stw_compat();
  if (!$compat['lists']) return ['rows' => [], 'full' => 0, 'now' => time(), 'run' => null, 'compat' => $compat];
  $info   = (new DockerTemplates())->getAllInfo();
  $DockerUpdate = new DockerUpdate();
  $status = DockerUtil::loadJSON($dockerManPaths['update-status']);
  $notes  = stw_notes();
  $mt     = stw_mtime();
  $rows   = [];
  foreach (stw_containers() as $i => $c) {
    $name = $c['Name'];
    $inf  = $info[$name] ?? [];
    $tag  = DockerUtil::ensureImageTag($c['Image']);
    $st   = $status[$tag] ?? [];

    // Read the live status file, not $inf['updated']: Unraid caches that flag in a separate file that only
    // its own full check refreshes, so it would show stale results after a single-container check.
    $updated = var_export($DockerUpdate->getUpdateStatus($c['Image']), true);
    if (substr($c['NetworkMode'] ?? '', -4) === ':???') $verdict = 'rebuild';
    elseif ($updated === 'false') $verdict = 'available';
    elseif ($updated === 'true')  $verdict = 'current';
    else                          $verdict = 'unknown';

    // update_container only works on containers created from an Unraid template.
    $mgr = $c['Manager'] ?: 'unmanaged';
    $why = '';
    if ($mgr === 'composeman') $why = 'compose';
    elseif ($mgr !== 'dockerman') $why = 'unmanaged';
    elseif (empty($inf['template'])) $why = 'notemplate';

    // Only plain http(s) WebUI links, and only editor templates that really sit in Unraid's template folder.
    $url = (string)($inf['url'] ?? '');
    if (!preg_match('#^https?://[^\[\]\s]+$#i', $url)) $url = '';   // unresolved [IP]/[PORT] placeholders are not a link
    $tpl = (string)($inf['template'] ?? '');
    if (strpos($tpl, '/boot/config/plugins/dockerMan/templates-user/') !== 0 || strpos($tpl, '..') !== false || !is_file($tpl)) $tpl = '';

    $own = $notes['at'][$tag] ?? null;
    $rows[] = [
      'n'       => $i + 1,
      'name'    => $name,
      'id'      => (string)($c['Id'] ?? ''),
      'image'   => $c['Image'],
      'icon'    => $inf['icon'] ?? '',
      'running' => (bool)$c['Running'],
      'paused'  => (bool)$c['Paused'],
      'verdict' => $verdict,
      'local'   => stw_digest($st['local'] ?? ''),
      'remote'  => stw_digest($st['remote'] ?? ''),
      'checked' => $own !== null ? (int)$own : ($notes['after'] === $mt ? (int)$notes['base'] : $mt),
      'status'  => (string)($c['Status'] ?? ''),
      'url'     => $url,
      'tpl'     => $tpl,
      'shell'   => (string)($inf['shell'] ?? ''),
      'can'     => $why === '',
      'why'     => $why,
    ];
  }
  return ['rows' => $rows, 'full' => (int)$notes['base'], 'now' => time(), 'run' => stw_run_state(), 'compat' => $compat];
}

/* ------------------------------------------------------------- one check
 * Asks the registry about ONE container's image through the stock
 * DockerUpdate::reloadUpdateStatus(). That method reads and rewrites the whole
 * shared status file without locking, so concurrent checks could lose each
 * other's entry; they are serialised with flock here. On a registry failure the
 * stock code would overwrite a good entry with "undef": the old entry is put
 * back instead and the check is reported as failed. */
function stw_check($name) {
  global $dockerManPaths;
  $found = null;
  foreach (stw_containers() as $c) if ($c['Name'] === $name) { $found = $c; break; }
  if (!$found) return ['ok' => false, 'code' => 'unknown_container'];

  $tag  = DockerUtil::ensureImageTag($found['Image']);
  $path = $dockerManPaths['update-status'];
  stw_tmp();
  $fh = @fopen(STW_LOCK, 'c');
  if (!$fh || !flock($fh, LOCK_EX)) return ['ok' => false, 'code' => 'lock'];
  try {
    $before = DockerUtil::loadJSON($path)[$tag] ?? null;
    $notes  = stw_notes();

    ob_start();
    try { (new DockerUpdate())->reloadUpdateStatus($tag); } catch (Throwable $e) { /* counted as failed below */ }
    ob_end_clean();

    $all = DockerUtil::loadJSON($path);
    $now = $all[$tag] ?? null;
    $ok  = is_array($now) && !empty($now['local']) && !empty($now['remote']);
    if (!$ok && $before !== null) { $all[$tag] = $before; DockerUtil::saveJSON($path, $all); }
    if ($ok) $notes['at'][$tag] = time();
    $notes['after'] = stw_mtime();
    @file_put_contents(STW_STATE, json_encode($notes), LOCK_EX);

    $cur = $ok ? $now : ($before ?? []);
    return [
      'ok' => $ok, 'code' => $ok ? 'ok' : 'registry',
      'status' => (string)($cur['status'] ?? 'undef'),
      'local' => stw_digest($cur['local'] ?? ''), 'remote' => stw_digest($cur['remote'] ?? ''),
    ];
  } finally {
    flock($fh, LOCK_UN);
    fclose($fh);
  }
}

/* ------------------------------------------------------------------- runs
 * An update run is a background worker (worker.php) that calls the stock
 * update_container script for one container after the other and records
 * progress in run.json, so the page can follow it, and pick it up again after a
 * reload. Item states: queued, running, done, failed. */
function stw_run_state() {
  $r = is_file(STW_RUN) ? json_decode((string)@file_get_contents(STW_RUN), true) : null;
  if (!is_array($r)) return null;
  $alive = !$r['finished'] && (($r['pid'] ?? 0) > 0 ? is_dir('/proc/' . (int)$r['pid']) : time() - (int)$r['started'] < 20);
  if (!$r['finished'] && !$alive) {      // worker died: close the run honestly
    foreach ($r['items'] as &$it) if (in_array($it['state'], ['queued', 'running'], true)) $it['state'] = 'failed';
    unset($it);
    $r['finished'] = time();
    stw_run_write($r);
  }
  return $r;
}

function stw_run_write($r) {
  stw_tmp();
  $tmp = STW_RUN . '.tmp';
  file_put_contents($tmp, json_encode($r));
  rename($tmp, STW_RUN);
}

function stw_run_active() {
  $r = stw_run_state();
  return $r && !$r['finished'];
}
