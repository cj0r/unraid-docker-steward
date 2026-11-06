<?PHP
$docroot ??= ($_SERVER['DOCUMENT_ROOT'] ?: '/usr/local/emhttp');
require_once "$docroot/plugins/docker.steward/php/lib.php";
stw_reply(stw_snapshot());
