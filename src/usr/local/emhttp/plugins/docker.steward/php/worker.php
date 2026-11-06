<?PHP
/* Background worker started by run.php. Applies the queued updates one by one
 * through the stock update_container script (the one behind the Docker page's
 * "apply update"), in priority order, and records progress in run.json. */
if (PHP_SAPI !== 'cli') exit;
$docroot = '/usr/local/emhttp';
require_once "$docroot/plugins/docker.steward/php/lib.php";

$run = json_decode((string)@file_get_contents(STW_RUN), true);
if (!is_array($run) || $run['finished']) exit;
$run['pid'] = getmypid();
stw_run_write($run);

$script = "$docroot/plugins/dynamix.docker.manager/scripts/update_container";
@file_put_contents(STW_LOG, '');
foreach ($run['items'] as $k => $it) {
  $run['items'][$k]['state'] = 'running';
  stw_run_write($run);

  $out = [];
  exec(escapeshellarg($script) . ' ' . escapeshellarg(rawurlencode($it['name'])) . ' 2>&1', $out, $code);
  @file_put_contents(STW_LOG, "== {$it['name']} (exit $code)\n" . implode("\n", array_slice($out, -40)) . "\n", FILE_APPEND);

  // Judge by what actually happened, not by the exit code alone: the script can exit 0 after a failed pull.
  $id = ''; $image = '';
  foreach ((new DockerClient())->getDockerContainers() as $c) if ($c['Name'] === $it['name']) { $id = (string)$c['Id']; $image = $c['Image']; }
  $renewed = $id !== '' && $id !== $it['from'];
  $cur = ($image !== '' ? (DockerUtil::loadJSON($dockerManPaths['update-status'])[DockerUtil::ensureImageTag($image)]['status'] ?? '') : '') === 'true';
  $run['items'][$k]['renewed'] = $renewed;
  $run['items'][$k]['state'] = ($code !== 0 || $id === '') ? 'failed' : ($renewed ? 'done' : ($cur ? 'unchanged' : 'failed'));
}
$run['finished'] = time();
stw_run_write($run);
