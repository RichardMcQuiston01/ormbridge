<?php
/**
 * Runs generated Laravel output against the real Illuminate components.
 *
 * 1. Runs every migration (database/migrations, in file name order) against
 *    an in-memory SQLite database with Capsule and the Schema facade.
 * 2. Loads every generated Eloquent model and persists a row per table
 *    (values come from the column types, the casts and the foreign keys), then
 *    checks both sides of every relationship method, many-to-many attach,
 *    enum casts, UUID keys and soft deletes.
 * 3. Runs every migration's down() in reverse order and checks that no table
 *    is left behind.
 *
 * Usage: LARAVEL_DIR=/path/with/vendor php validate-laravel.php <output dir>
 *
 * <output dir> is the directory the laravel format wrote (it contains app/ and
 * database/). Needs illuminate/database, illuminate/events, illuminate/container
 * and illuminate/support (Laravel 11 or newer).
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
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Database\Eloquent\Relations\Relation;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Events\Dispatcher;
use Illuminate\Support\Facades\Facade;

$dir = rtrim($argv[1] ?? '', '/');
if ($dir === '' || !is_dir($dir)) {
    fwrite(STDERR, "Pass the output directory as the first argument.\n");
    exit(2);
}

$failures = [];
$check = static function (bool $condition, string $message) use (&$failures): void {
    if (!$condition) {
        $failures[] = $message;
        echo "FAIL $message\n";
    }
};

// ---------------------------------------------------------------------------
// Boot Illuminate
// ---------------------------------------------------------------------------

$container = new Container();
Container::setInstance($container);
$capsule = new Capsule($container);
$capsule->addConnection([
    'driver' => 'sqlite',
    'database' => ':memory:',
    'prefix' => '',
    'foreign_key_constraints' => true,
]);
$capsule->setEventDispatcher(new Dispatcher($container));
$capsule->setAsGlobal();
$capsule->bootEloquent();
$connection = $capsule->getConnection();
$schema = $connection->getSchemaBuilder();
$container->instance('db', $capsule->getDatabaseManager());
$container->instance('db.schema', $schema);
Facade::setFacadeApplication($container);

// ---------------------------------------------------------------------------
// 1. Migrations: up()
// ---------------------------------------------------------------------------

$files = glob($dir . '/database/migrations/*.php') ?: [];
sort($files, SORT_STRING);
$check(count($files) > 0, 'no migrations found in database/migrations');
$migrations = [];
foreach ($files as $file) {
    $migration = require $file;
    $migrations[basename($file)] = $migration;
}
$ran = [];
foreach ($migrations as $name => $migration) {
    try {
        $migration->up();
        $ran[] = $name;
    } catch (Throwable $error) {
        $check(false, "up() of $name: " . $error->getMessage());
    }
}
$tables = array_map(static fn (array $table): string => $table['name'], $schema->getTables());
echo count($ran) . ' migrations ran up, ' . count($tables) . " tables created\n";

// ---------------------------------------------------------------------------
// 2. Models
// ---------------------------------------------------------------------------

spl_autoload_register(static function (string $class) use ($dir): void {
    static $map = null;
    if ($map === null) {
        $map = [];
        $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir . '/app'));
        foreach ($iterator as $file) {
            if ($file->isFile() && $file->getExtension() === 'php') {
                $source = (string) file_get_contents($file->getPathname());
                if (
                    preg_match('/^namespace\s+([^;]+);/m', $source, $namespace) === 1
                    && preg_match('/^(?:class|enum)\s+(\w+)/m', $source, $name) === 1
                ) {
                    $map[$namespace[1] . '\\' . $name[1]] = $file->getPathname();
                }
            }
        }
    }
    if (isset($map[$class])) {
        require $map[$class];
    }
});

$modelClasses = [];
$iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir . '/app'));
foreach ($iterator as $file) {
    if (!$file->isFile() || $file->getExtension() !== 'php') {
        continue;
    }
    $source = (string) file_get_contents($file->getPathname());
    if (
        preg_match('/^namespace\s+([^;]+);/m', $source, $namespace) === 1
        && preg_match('/^class\s+(\w+)\s+extends\s+Model/m', $source, $name) === 1
    ) {
        $modelClasses[] = $namespace[1] . '\\' . $name[1];
    }
}
sort($modelClasses);
foreach (glob($dir . '/app/*/*.php') ?: [] as $php) {
    $lint = [];
    exec('php -l ' . escapeshellarg($php) . ' 2>&1', $lint, $status);
    $check($status === 0, "php -l $php");
}

/** @var array<string, class-string<Model>> $modelByTable */
$modelByTable = [];
foreach ($modelClasses as $class) {
    $model = new $class();
    $check($model instanceof Model, "$class is not an Eloquent model");
    $table = $model->getTable();
    $check(in_array($table, $tables, true), "$class: table '$table' does not exist after the migrations");
    $modelByTable[$table] = $class;
}
echo count($modelClasses) . " models loaded\n";

$defaultValue = static function (Model $model, string $column, array $info) {
    $casts = $model->getCasts();
    $cast = $casts[$column] ?? null;
    if ($cast !== null && enum_exists($cast)) {
        return $cast::cases()[0]->value;
    }
    if ($cast === 'array') {
        return ['a' => 1];
    }
    if ($cast === 'boolean') {
        return true;
    }
    if ($cast === 'datetime') {
        return '2024-01-02 03:04:05';
    }
    if ($cast === 'date') {
        return '2024-01-02';
    }
    if ($cast !== null && str_starts_with((string) $cast, 'decimal')) {
        return '1.50';
    }
    $type = strtolower((string) $info['type_name']);
    if (str_contains($type, 'int')) {
        return 1;
    }
    if (preg_match('/real|floa|doub|numeric|decimal/', $type) === 1) {
        return 1.5;
    }
    if (str_contains($type, 'datetime')) {
        return '2024-01-02 03:04:05';
    }
    if ($type === 'date') {
        return '2024-01-02';
    }
    if ($type === 'time') {
        return '03:04:05';
    }
    return 'v_' . $column;
};

/** @var array<string, Model> $created table => persisted instance */
$created = [];

/** Persists one row for a table. Returns 'wait' when a referenced table has no row yet. */
$createRow = static function (string $table) use (
    $modelByTable, $schema, &$created, $check, $defaultValue
): string {
    $class = $modelByTable[$table];
    $model = new $class();
    $columns = $schema->getColumns($table);
    $foreign = [];
    foreach ($schema->getForeignKeys($table) as $key) {
        $foreign[$key['columns'][0]] = $key;
    }
    $traits = class_uses_recursive($class);
    $usesUuid = in_array(Illuminate\Database\Eloquent\Concerns\HasUuids::class, $traits, true)
        || in_array(Illuminate\Database\Eloquent\Concerns\HasUlids::class, $traits, true);
    $generatedKey = $usesUuid && in_array($model->getKeyName(), $model->uniqueIds(), true);
    $values = [];
    foreach ($columns as $info) {
        $column = $info['name'];
        if ($info['auto_increment'] && !isset($foreign[$column])) {
            continue;
        }
        if ($generatedKey && $column === $model->getKeyName()) {
            continue;
        }
        if ($usesUuid && in_array($column, $model->uniqueIds(), true)) {
            continue;
        }
        if ($model->usesTimestamps() && in_array($column, [$model::CREATED_AT, $model::UPDATED_AT], true)) {
            continue;
        }
        if (in_array(SoftDeletes::class, $traits, true) && $column === 'deleted_at') {
            continue;
        }
        if (isset($foreign[$column])) {
            $targetTable = $foreign[$column]['foreign_table'];
            $targetColumn = $foreign[$column]['foreign_columns'][0];
            if ($targetTable === $table) {
                continue;
            }
            if (!isset($created[$targetTable])) {
                if ($info['nullable']) {
                    continue;
                }
                return 'wait';
            }
            $values[$column] = $created[$targetTable]->getAttribute($targetColumn);
            continue;
        }
        $values[$column] = $defaultValue($model, $column, $info);
    }
    $fillable = $model->getFillable();
    foreach (array_keys($values) as $column) {
        $check(
            in_array($column, $fillable, true),
            "$class: column '$column' is required but missing from \$fillable"
        );
    }
    try {
        $model->fill($values);
        $model->save();
        $created[$table] = $model;
    } catch (Throwable $error) {
        $check(false, "$class: save() failed: " . $error->getMessage());
        return 'failed';
    }

    // Keys and generated values.
    if ($usesUuid) {
        foreach ($model->uniqueIds() as $column) {
            $value = $model->getAttribute($column);
            $check(
                is_string($value) && preg_match('/^[0-9a-f-]{36}$|^[0-9A-HJKMNP-TV-Z]{26}$/i', $value) === 1,
                "$class: '$column' was not generated as a UUID or ULID: " . var_export($value, true)
            );
        }
        if ($generatedKey) {
            $check($model->getKeyType() === 'string' && !$model->getIncrementing(), "$class: key type/incrementing");
        } else {
            $check($model->getKeyType() === 'int' || $model->getIncrementing(), "$class: an integer key stays an integer key");
        }
    }

    // Casts: reload and check the cast values.
    if ($model->getKey() !== null && count($model->getCasts()) > 0) {
        $fresh = $class::query()->withoutGlobalScopes()->find($model->getKey());
        $check($fresh !== null, "$class: the saved row cannot be found again");
        foreach ($model->getCasts() as $column => $cast) {
            if ($fresh === null || !array_key_exists($column, $fresh->getAttributes())) {
                continue;
            }
            if (enum_exists((string) $cast)) {
                $check($fresh->{$column} instanceof BackedEnum, "$class.$column should be an enum case");
            }
            if ($cast === 'array' && $fresh->{$column} !== null) {
                $check(is_array($fresh->{$column}), "$class.$column should be an array");
            }
            if ($cast === 'boolean' && $fresh->{$column} !== null) {
                $check(is_bool($fresh->{$column}), "$class.$column should be a bool");
            }
            if ($cast === 'datetime' && $fresh->{$column} !== null) {
                $check($fresh->{$column} instanceof DateTimeInterface, "$class.$column should be a date");
            }
        }
    }

    // Soft deletes.
    if (in_array(SoftDeletes::class, $traits, true)) {
        $model->delete();
        $check($model->trashed(), "$class: not trashed after delete()");
        $check($class::query()->count() === 0, "$class: soft deleted row is still visible");
        $check($class::withTrashed()->count() === 1, "$class: withTrashed() lost the row");
        $model->restore();
        $check($class::query()->count() === 1, "$class: restore() failed");
    }
    return 'created';
};

$pending = array_values(array_filter($tables, static fn (string $table): bool => isset($modelByTable[$table])));
while (count($pending) > 0) {
    $next = [];
    foreach ($pending as $table) {
        if ($createRow($table) === 'wait') {
            $next[] = $table;
        }
    }
    if (count($next) === count($pending)) {
        foreach ($next as $table) {
            $check(false, "$modelByTable[$table]: a referenced table has no row");
        }
        break;
    }
    $pending = $next;
}
echo count($created) . " rows persisted\n";

// ---------------------------------------------------------------------------
// Relationships (both sides)
// ---------------------------------------------------------------------------

/** @return array<string, Relation> */
$relationsOf = static function (string $class): array {
    $found = [];
    $reflection = new ReflectionClass($class);
    foreach ($reflection->getMethods(ReflectionMethod::IS_PUBLIC) as $method) {
        if ($method->class !== $class || $method->getNumberOfParameters() > 0) {
            continue;
        }
        $type = $method->getReturnType();
        if ($type instanceof ReflectionNamedType && is_subclass_of($type->getName(), Relation::class)) {
            $found[$method->getName()] = $method->getName();
        }
    }
    return $found;
};

$relationCount = 0;
foreach ($created as $table => $instance) {
    $class = $instance::class;
    foreach ($relationsOf($class) as $name) {
        $relationCount += 1;
        try {
            $relation = $instance->{$name}();
        } catch (Throwable $error) {
            $check(false, "$class::$name(): " . $error->getMessage());
            continue;
        }
        $related = $relation->getRelated();
        $relatedClass = $related::class;
        try {
            if ($relation instanceof BelongsTo) {
                $foreignKey = $relation->getForeignKeyName();
                $check(
                    in_array($foreignKey, array_column($schema->getColumns($table), 'name'), true),
                    "$class::$name(): foreign key column '$foreignKey' does not exist on '$table'"
                );
                $parent = $instance->{$name};
                if ($instance->getAttribute($foreignKey) !== null) {
                    $check($parent instanceof $relatedClass, "$class::$name should load a $relatedClass");
                    // The other side must list this row.
                    $peers = array_filter(
                        $relationsOf($relatedClass),
                        static function (string $peerName) use ($parent, $relatedClass, $class, $foreignKey): bool {
                            $peer = $parent->{$peerName}();
                            return ($peer instanceof HasMany || $peer instanceof HasOne)
                                && $peer->getRelated()::class === $class
                                && $peer->getForeignKeyName() === $foreignKey;
                        }
                    );
                    $check(count($peers) > 0, "$relatedClass has no hasMany/hasOne counterpart for $class::$name ($foreignKey)");
                    foreach ($peers as $peerName) {
                        $members = $parent->{$peerName}()->get();
                        $check(
                            $members->contains(fn (Model $member): bool => $member->is($instance)),
                            "$relatedClass::$peerName() does not contain the $class row"
                        );
                    }
                }
            } elseif ($relation instanceof HasMany || $relation instanceof HasOne) {
                $foreignKey = $relation->getForeignKeyName();
                $local = $relation->getLocalKeyName();
                $expected = $connection->table($related->getTable())
                    ->where($foreignKey, $instance->getAttribute($local))
                    ->count();
                $actual = $relation instanceof HasMany
                    ? $relation->count()
                    : ($relation->getResults() === null ? 0 : 1);
                $check($actual === $expected, "$class::$name(): expected $expected related rows, found $actual");
            } elseif ($relation instanceof BelongsToMany) {
                $relatedTable = $related->getTable();
                if (!isset($created[$relatedTable])) {
                    $check(false, "$class::$name(): no $relatedClass row to attach");
                    continue;
                }
                $other = $created[$relatedTable];
                $relation->attach($other->getKey());
                $check($relation->count() === 1, "$class::$name(): attach() did not create one pivot row");
                $check($instance->{$name}()->get()->first()?->is($other) === true, "$class::$name should return the attached model");
                $peerFound = false;
                foreach ($relationsOf($relatedClass) as $peerName) {
                    $peer = $other->{$peerName}();
                    if (
                        $peer instanceof BelongsToMany
                        && $peer->getRelated()::class === $class
                        && $peer->getTable() === $relation->getTable()
                        && $peerName !== $name
                    ) {
                        $peerFound = true;
                        $check(
                            $peer->get()->contains(fn (Model $member): bool => $member->is($instance)),
                            "$relatedClass::$peerName() does not contain the $class row"
                        );
                    }
                }
                $check($peerFound || $class === $relatedClass, "$relatedClass has no belongsToMany counterpart for $class::$name");
                $relation->detach();
                $check($relation->count() === 0, "$class::$name(): detach() failed");
            }
        } catch (Throwable $error) {
            $check(false, "$class::$name: " . $error->getMessage());
        }
    }
}
echo "$relationCount relationship methods checked\n";

// ---------------------------------------------------------------------------
// 3. Migrations: down()
// ---------------------------------------------------------------------------

foreach (array_reverse($ran) as $name) {
    try {
        $migrations[$name]->down();
    } catch (Throwable $error) {
        $check(false, "down() of $name: " . $error->getMessage());
    }
}
$remaining = array_map(static fn (array $table): string => $table['name'], $schema->getTables());
$check(count($remaining) === 0, 'tables left after down(): ' . implode(', ', $remaining));
echo "migrations rolled back, " . count($remaining) . " tables left\n";

if (count($failures) > 0) {
    echo count($failures) . " problems\n";
    exit(1);
}
echo "laravel output verified\n";
exit(0);
