using System.Reflection;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

// Usage: dotnet run -- <DbContext type name> [more type names]
//
// For each DbContext, creates the database in memory with EnsureCreated() (EF Core's own model building and
// SQLite DDL generation) and prints, as JSON, what SQLite reports for every table: the columns with nullability
// and primary key position, the indexes and the foreign keys with their actions. The test compares that with
// the schema ormbridge read from the same C# source.

var output = new Dictionary<string, object>();
foreach (var name in args)
{
    var contextType = Assembly.GetExecutingAssembly()
        .GetTypes()
        .FirstOrDefault(t => typeof(DbContext).IsAssignableFrom(t) && (t.Name == name || t.FullName == name));
    if (contextType is null)
    {
        Console.Error.WriteLine($"No DbContext called {name} was found.");
        return 2;
    }

    using var connection = new SqliteConnection("Data Source=:memory:");
    connection.Open();
    var builderType = typeof(DbContextOptionsBuilder<>).MakeGenericType(contextType);
    var builder = (DbContextOptionsBuilder)Activator.CreateInstance(builderType)!;
    builder.UseSqlite(connection);
    using var context = (DbContext)Activator.CreateInstance(contextType, builder.Options)!;
    context.Database.EnsureCreated();
    output[contextType.Name] = Describe(connection);
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
