<?php
/**
 * Loads generated Doctrine entities with the real metadata factory, validates
 * the mapping (SchemaValidator, the same check as `orm:validate-schema
 * --skip-sync`) and creates the schema in an in-memory SQLite database.
 *
 * Usage: DOCTRINE_DIR=/path/with/vendor php validate.php <output dir> [namespace root]
 *
 * <output dir> is the directory the doctrine format wrote (it contains src/Entity).
 * The namespace root defaults to "App" and maps to <output dir>/src/.
 */

declare(strict_types=1);

$vendor = getenv('DOCTRINE_DIR');
if ($vendor === false || !is_file($vendor . '/vendor/autoload.php')) {
    fwrite(STDERR, "Set DOCTRINE_DIR to a directory that contains vendor/autoload.php.\n");
    exit(2);
}
require $vendor . '/vendor/autoload.php';

use Doctrine\DBAL\DriverManager;
use Doctrine\ORM\EntityManager;
use Doctrine\ORM\ORMSetup;
use Doctrine\ORM\Tools\SchemaTool;
use Doctrine\ORM\Tools\SchemaValidator;

$dir = $argv[1] ?? '';
$root = $argv[2] ?? 'App';

spl_autoload_register(static function (string $class) use ($dir, $root): void {
    $prefix = $root . '\\';
    if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
        return;
    }
    $file = $dir . '/src/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
    if (is_file($file)) {
        require $file;
    }
});

$config = ORMSetup::createAttributeMetadataConfiguration([$dir . '/src/Entity'], true);
$connection = DriverManager::getConnection(['driver' => 'pdo_sqlite', 'memory' => true], $config);
$em = new EntityManager($connection, $config);

$failed = false;
foreach ((new SchemaValidator($em))->validateMapping() as $class => $messages) {
    foreach ($messages as $message) {
        echo "MAPPING ERROR $class: $message\n";
        $failed = true;
    }
}

$metadata = $em->getMetadataFactory()->getAllMetadata();
echo count($metadata) . " entities loaded\n";
$statements = (new SchemaTool($em))->getCreateSchemaSql($metadata);
foreach ($statements as $statement) {
    $connection->executeStatement($statement);
}
echo 'schema created in sqlite (' . count($statements) . " statements)\n";
exit($failed ? 1 : 0);
