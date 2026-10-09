<?php
/**
 * Runs Laravel migrations in file-name order against an in-memory SQLite
 * database with the real Illuminate packages, then prints the resulting schema
 * as JSON: for every table its columns, foreign keys and indexes.
 *
 * Usage: LARAVEL_DIR=/path/with/vendor php replay-laravel-migrations.php <migrations dir>
 *
 * LARAVEL_DIR is a directory (outside this repository) where
 * `composer require illuminate/database illuminate/events illuminate/container`
 * has been run.
 */

declare(strict_types=1);

$vendor = getenv('LARAVEL_DIR');
if ($vendor === false || !is_file($vendor . '/vendor/autoload.php')) {
    fwrite(STDERR, "Set LARAVEL_DIR to a directory that contains vendor/autoload.php.\n");
    exit(2);
}
require $vendor . '/vendor/autoload.php';

use Illuminate\Container\Container;
use Illuminate\Database\Capsule\Manager as Capsule;
use Illuminate\Events\Dispatcher;
use Illuminate\Support\Facades\Facade;

$directory = $argv[1] ?? '';
$files = glob($directory . '/*.php');
if ($files === false || $files === []) {
    fwrite(STDERR, "No migration files found in {$directory}.\n");
    exit(2);
}
sort($files);

$capsule = new Capsule();
$capsule->addConnection(['driver' => 'sqlite', 'database' => ':memory:', 'prefix' => '']);
$capsule->setEventDispatcher(new Dispatcher(new Container()));
$capsule->setAsGlobal();
$capsule->bootEloquent();

// The Schema and DB facades resolve their services from the container.
$container = Container::getInstance();
$container->instance('db', $capsule->getDatabaseManager());
$container->instance('db.connection', $capsule->getConnection());
$container->instance('db.schema', $capsule->getConnection()->getSchemaBuilder());
Facade::setFacadeApplication($container);

foreach ($files as $file) {
    $result = require $file;
    if (is_object($result)) {
        $migration = $result;
    } else {
        // Named class: the class name is the studly-cased file name without the date prefix.
        $name = preg_replace('/^\d+_\d+_\d+_\d+_/', '', basename($file, '.php'));
        $class = str_replace(' ', '', ucwords(str_replace('_', ' ', (string) $name)));
        $migration = new $class();
    }
    $migration->up();
}

$pdo = $capsule->getConnection()->getPdo();
$tables = $pdo
    ->query("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name")
    ->fetchAll(PDO::FETCH_COLUMN);

$schema = [];
foreach ($tables as $table) {
    $columns = [];
    foreach ($pdo->query("pragma table_info('{$table}')") as $column) {
        $columns[] = [
            'name' => $column['name'],
            'type' => $column['type'],
            'notNull' => (bool) $column['notnull'],
            'default' => $column['dflt_value'],
            'primaryKeyPosition' => (int) $column['pk'],
        ];
    }
    $foreignKeys = [];
    foreach ($pdo->query("pragma foreign_key_list('{$table}')") as $key) {
        $foreignKeys[] = [
            'column' => $key['from'],
            'table' => $key['table'],
            'references' => $key['to'],
            'onDelete' => $key['on_delete'],
        ];
    }
    $indexes = [];
    foreach ($pdo->query("pragma index_list('{$table}')") as $index) {
        $indexColumns = $pdo
            ->query("pragma index_info('{$index['name']}')")
            ->fetchAll(PDO::FETCH_COLUMN, 2);
        $indexes[] = [
            'name' => $index['name'],
            'unique' => (bool) $index['unique'],
            'origin' => $index['origin'],
            'columns' => $indexColumns,
        ];
    }
    $schema[$table] = ['columns' => $columns, 'foreignKeys' => $foreignKeys, 'indexes' => $indexes];
}

echo json_encode($schema, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
