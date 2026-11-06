<?PHP
/* POST name=<container>: check one container's image against its registry. */
$docroot ??= ($_SERVER['DOCUMENT_ROOT'] ?: '/usr/local/emhttp');
require_once "$docroot/plugins/docker.steward/php/lib.php";

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') stw_reply(['ok' => false, 'code' => 'method'], 405);
$name = $_POST['name'] ?? '';
if (!stw_valid_name($name)) stw_reply(['ok' => false, 'code' => 'bad_name'], 400);

if (!stw_compat()['lists']) stw_reply(['ok' => false, 'code' => 'unsupported'], 503);
$res = stw_check($name);
if (($res['code'] ?? '') === 'unknown_container') stw_reply($res, 404);
stw_reply($res + ['name' => $name, 'at' => time()]);
