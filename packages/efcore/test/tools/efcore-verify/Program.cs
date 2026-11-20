using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;

// Usage: dotnet run -- [--exercise] <DbContext type name or full name> [more names]
//
// For each DbContext, creates the database in memory with EnsureCreated() (EF Core's own model building and
// SQLite DDL generation) and prints, as JSON keyed by the name that was given, what SQLite reports for every
// table: the columns with nullability and primary key position, the indexes and the foreign keys with their
// actions. The tests compare that with the schema ormbridge read, or wrote. A context whose model EF Core rejects
// is reported as {"__error": "<message>"} so one bad model does not hide the others.
//
// With --exercise each result also has an "__exercise" entry: the tool adds one row to every table through the
// entity classes (the columns that have a default, a generator or a value converter are left for EF Core and the
// database to fill), saves, and reads the rows back with plain SQL. It then marks every entity as modified and
// saves again, to see which columns the context refreshes on update.

var exercise = args.Contains("--exercise");
var output = new Dictionary<string, object>();
foreach (var name in args.Where(argument => argument != "--exercise"))
{
    var contextType = Assembly.GetExecutingAssembly()
        .GetTypes()
        .FirstOrDefault(t => typeof(DbContext).IsAssignableFrom(t) && (t.Name == name || t.FullName == name));
    if (contextType is null)
    {
        Console.Error.WriteLine($"No DbContext called {name} was found.");
        return 2;
    }

    try
    {
        using var connection = new SqliteConnection("Data Source=:memory:");
        connection.Open();
        var builderType = typeof(DbContextOptionsBuilder<>).MakeGenericType(contextType);
        var builder = (DbContextOptionsBuilder)Activator.CreateInstance(builderType)!;
        builder.UseSqlite(connection);
        if (Environment.GetEnvironmentVariable("EFCORE_VERIFY_LOG") == "1")
        {
            // For debugging a model: prints the SQL EF Core runs to stderr.
            builder.EnableSensitiveDataLogging().LogTo(Console.Error.WriteLine, Microsoft.Extensions.Logging.LogLevel.Information);
        }
        using var context = (DbContext)Activator.CreateInstance(contextType, builder.Options)!;
        context.Database.EnsureCreated();
        var described = Describe(connection);
        if (exercise)
        {
            described["__exercise"] = Exercise(context, connection);
        }
        output[name] = described;
    }
    catch (Exception exception)
    {
        output[name] = new Dictionary<string, string> { ["__error"] = exception.ToString() };
    }
}

Console.WriteLine(JsonSerializer.Serialize(output, new JsonSerializerOptions { WriteIndented = true }));
return 0;

static List<Dictionary<string, object?>> Query(SqliteConnection connection, string sql)
{
    using var command = connection.CreateCommand();
    command.CommandText = sql;
    using var reader = command.ExecuteReader();
    var rows = new List<Dictionary<string, object?>>();
    while (reader.Read())
    {
        var row = new Dictionary<string, object?>();
        for (var i = 0; i < reader.FieldCount; i++)
        {
            row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
        }
        rows.Add(row);
    }
    return rows;
}

static Dictionary<string, object> Describe(SqliteConnection connection)
{
    var tables = new Dictionary<string, object>();
    var names = Query(connection, "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name")
        .Select(row => (string)row["name"]!);
    foreach (var table in names)
    {
        var quoted = "\"" + table.Replace("\"", "\"\"") + "\"";
        var columns = Query(connection, $"pragma table_xinfo({quoted})")
            .Select(row => new Dictionary<string, object?>
            {
                ["name"] = row["name"],
                ["type"] = row["type"],
                ["notNull"] = Convert.ToInt64(row["notnull"]) == 1,
                ["primaryKey"] = Convert.ToInt64(row["pk"]),
                ["generated"] = Convert.ToInt64(row["hidden"]) >= 2,
                ["default"] = row["dflt_value"],
            })
            .ToList();
        var indexes = new List<Dictionary<string, object?>>();
        foreach (var index in Query(connection, $"pragma index_list({quoted})"))
        {
            var indexName = (string)index["name"]!;
            var origin = (string)index["origin"]!;
            var indexColumns = Query(connection, $"pragma index_info(\"{indexName}\")")
                .OrderBy(row => Convert.ToInt64(row["seqno"]))
                .Select(row => (string)row["name"]!)
                .ToList();
            indexes.Add(new Dictionary<string, object?>
            {
                ["name"] = indexName,
                ["unique"] = Convert.ToInt64(index["unique"]) == 1,
                ["origin"] = origin,
                ["columns"] = indexColumns,
            });
        }
        var foreignKeys = Query(connection, $"pragma foreign_key_list({quoted})")
            .GroupBy(row => Convert.ToInt64(row["id"]))
            .Select(group => new Dictionary<string, object?>
            {
                ["table"] = group.First()["table"],
                ["from"] = group.OrderBy(row => Convert.ToInt64(row["seq"])).Select(row => row["from"]).ToList(),
                ["to"] = group.OrderBy(row => Convert.ToInt64(row["seq"])).Select(row => row["to"]).ToList(),
                ["onDelete"] = group.First()["on_delete"],
                ["onUpdate"] = group.First()["on_update"],
            })
            .ToList();
        tables[table] = new Dictionary<string, object>
        {
            ["columns"] = columns,
            ["indexes"] = indexes,
            ["foreignKeys"] = foreignKeys,
        };
    }
    return tables;
}

static object? Sample(IProperty property)
{
    var type = Nullable.GetUnderlyingType(property.ClrType) ?? property.ClrType;
    if (type == typeof(string)) return "x";
    if (type == typeof(int)) return 1;
    if (type == typeof(long)) return 1L;
    if (type == typeof(short)) return (short)1;
    if (type == typeof(byte)) return (byte)1;
    if (type == typeof(bool)) return true;
    if (type == typeof(decimal)) return 1.5m;
    if (type == typeof(double)) return 1.5d;
    if (type == typeof(float)) return 1.5f;
    if (type == typeof(DateTime)) return new DateTime(2020, 1, 2, 3, 4, 5, DateTimeKind.Utc);
    if (type == typeof(DateOnly)) return new DateOnly(2020, 1, 2);
    if (type == typeof(TimeOnly)) return new TimeOnly(3, 4, 5);
    if (type == typeof(TimeSpan)) return TimeSpan.FromMinutes(5);
    if (type == typeof(Guid)) return Guid.NewGuid();
    if (type == typeof(byte[])) return new byte[] { 1, 2 };
    if (type.IsEnum)
    {
        var values = Enum.GetValues(type);
        return values.Length > 0 ? values.GetValue(0) : Activator.CreateInstance(type);
    }
    if (type.IsArray) return Array.CreateInstance(type.GetElementType()!, 0);
    return null;
}

static Dictionary<string, object?> Exercise(DbContext context, SqliteConnection connection)
{
    var errors = new List<string>();
    var rows = new Dictionary<string, object?>();
    var updates = new Dictionary<string, object?>();
    var entries = new Dictionary<IEntityType, Microsoft.EntityFrameworkCore.ChangeTracking.EntityEntry>();

    var candidates = context.Model.GetEntityTypes()
        .Where(type => !type.IsOwned()
            && !type.ClrType.IsAbstract
            && type.FindPrimaryKey() is not null
            && type.GetTableName() is not null
            && !type.HasSharedClrType)
        .ToList();
    var ordered = new List<IEntityType>();
    var visiting = new HashSet<IEntityType>();
    void Visit(IEntityType type)
    {
        if (ordered.Contains(type) || !visiting.Add(type)) return;
        foreach (var foreignKey in type.GetForeignKeys())
        {
            if (!foreignKey.IsOwnership && foreignKey.PrincipalEntityType != type && candidates.Contains(foreignKey.PrincipalEntityType))
            {
                Visit(foreignKey.PrincipalEntityType);
            }
        }
        ordered.Add(type);
    }
    foreach (var type in candidates) Visit(type);

    foreach (var type in ordered)
    {
        var table = type.GetTableName()!;
        object? entity = null;
        try
        {
            entity = Activator.CreateInstance(type.ClrType)!;
            var entry = context.Add(entity);
            var foreignProperties = new HashSet<string>();
            foreach (var foreignKey in type.GetForeignKeys())
            {
                if (foreignKey.IsOwnership) continue;
                foreach (var property in foreignKey.Properties) foreignProperties.Add(property.Name);
                if (foreignKey.PrincipalEntityType == type || !entries.TryGetValue(foreignKey.PrincipalEntityType, out var principal))
                {
                    if (!foreignKey.IsRequired) continue;
                    throw new InvalidOperationException($"no row of {foreignKey.PrincipalEntityType.DisplayName()} exists to reference");
                }
                for (var i = 0; i < foreignKey.Properties.Count; i++)
                {
                    entry.Property(foreignKey.Properties[i].Name).CurrentValue =
                        principal.Property(foreignKey.PrincipalKey.Properties[i].Name).CurrentValue;
                }
            }
            foreach (var property in type.GetProperties())
            {
                if (foreignProperties.Contains(property.Name) || property.IsShadowProperty()) continue;
                if (property.ValueGenerated != ValueGenerated.Never) continue;
                if (property.IsNullable && !property.IsKey()) continue;
                var value = Sample(property);
                if (value is not null) entry.Property(property.Name).CurrentValue = value;
            }
            context.SaveChanges();
            entries[type] = entry;
            rows[table] = Query(connection, $"select * from \"{table.Replace("\"", "\"\"")}\" limit 1").FirstOrDefault();
        }
        catch (Exception exception)
        {
            errors.Add($"{table}: {exception.GetBaseException().Message}");
            if (entity is not null) context.Entry(entity).State = EntityState.Detached;
        }
    }

    foreach (var type in ordered)
    {
        if (!entries.TryGetValue(type, out var entry)) continue;
        var refreshed = type.GetProperties()
            .Where(property => property.ValueGenerated == ValueGenerated.OnAddOrUpdate
                && !property.IsKey()
                && (Nullable.GetUnderlyingType(property.ClrType) ?? property.ClrType) == typeof(DateTime)
                && property.GetComputedColumnSql() is null)
            .Select(property => property.GetColumnName())
            .ToList();
        if (refreshed.Count == 0) continue;
        var table = type.GetTableName()!;
        try
        {
            var before = Query(connection, $"select * from \"{table}\" limit 1").First();
            Thread.Sleep(30);
            entry.State = EntityState.Modified;
            context.SaveChanges();
            var after = Query(connection, $"select * from \"{table}\" limit 1").First();
            updates[table] = refreshed.ToDictionary(
                column => column,
                column => new object?[] { before[column], after[column] });
        }
        catch (Exception exception)
        {
            errors.Add($"{table} (update): {exception.GetBaseException().Message}");
        }
    }

    return new Dictionary<string, object?> { ["rows"] = rows, ["updates"] = updates, ["errors"] = errors };
}
