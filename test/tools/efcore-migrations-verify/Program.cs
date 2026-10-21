using System.Reflection;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.EntityFrameworkCore.Migrations.Design;
using Microsoft.EntityFrameworkCore.Migrations.Operations;
using Microsoft.Extensions.DependencyInjection;

// Usage: dotnet run -- <manifest.json>
//
// The manifest is a list of scenarios: { "name": "blog", "provider": "sqlite" | "npgsql", "contexts": ["Blog.V1.Context", ...] }.
// Each context is one version of a model (a DbContext in its own namespace). For every version the tool does what
// `dotnet ef migrations add` does: it asks EF Core's model differ for the operations that lead from the previous
// version to this one and has the C# migration generator write the migration class, its Designer file and the
// model snapshot. It prints, as JSON keyed by scenario name, the files of every step (as they would be in the
// Migrations folder) and a description of the model of that step taken from EF Core's relational model: tables,
// columns with their store type, CLR type and nullability, primary and unique keys, indexes and foreign keys.
// A scenario that fails is reported as { "__error": "<message>" } so one bad model does not hide the others.

var manifest = JsonSerializer.Deserialize<List<Scenario>>(
    File.ReadAllText(args[0]),
    new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
var output = new Dictionary<string, object>();
foreach (var scenario in manifest)
{
    try
    {
        output[scenario.Name] = new Dictionary<string, object> { ["steps"] = Run(scenario) };
    }
    catch (Exception exception)
    {
        output[scenario.Name] = new Dictionary<string, string> { ["__error"] = exception.ToString() };
    }
}

Console.WriteLine(JsonSerializer.Serialize(output, new JsonSerializerOptions { WriteIndented = true }));
return 0;

static List<Dictionary<string, object>> Run(Scenario scenario)
{
    var steps = new List<Dictionary<string, object>>();
    IModel? previous = null;
    var number = 0;
    foreach (var contextName in scenario.Contexts)
    {
        number += 1;
        var contextType = Assembly.GetExecutingAssembly()
            .GetTypes()
            .FirstOrDefault(t => typeof(DbContext).IsAssignableFrom(t) && t.FullName == contextName)
            ?? throw new InvalidOperationException($"No DbContext called {contextName} was found.");
        var builder = new DbContextOptionsBuilder();
        if (scenario.Provider == "npgsql")
        {
            builder.UseNpgsql("Host=localhost;Database=none");
        }
        else
        {
            builder.UseSqlite("Data Source=:memory:");
        }
        using var context = (DbContext)Activator.CreateInstance(contextType, builder.Options)!;
        var services = new ServiceCollection()
            .AddEntityFrameworkDesignTimeServices()
            .AddDbContextDesignTimeServices(context);
        if (scenario.Provider == "npgsql")
        {
            new Npgsql.EntityFrameworkCore.PostgreSQL.Design.Internal.NpgsqlDesignTimeServices().ConfigureDesignTimeServices(services);
        }
        else
        {
            new Microsoft.EntityFrameworkCore.Sqlite.Design.Internal.SqliteDesignTimeServices().ConfigureDesignTimeServices(services);
        }
        var provider = services.BuildServiceProvider();
        var model = context.GetService<IDesignTimeModel>().Model;
        var differ = context.GetService<IMigrationsModelDiffer>();
        var generator = provider.GetRequiredService<IMigrationsCodeGenerator>();
        var up = differ.GetDifferences(previous?.GetRelationalModel(), model.GetRelationalModel());
        var down = differ.GetDifferences(model.GetRelationalModel(), previous?.GetRelationalModel());
        // The ids sort like the timestamps `dotnet ef` writes, one second apart.
        var name = scenario.Names is not null && scenario.Names.Count >= number ? scenario.Names[number - 1] : $"Version{number}";
        var id = $"2024010112{(number / 60):00}{(number % 60):00}_{name}";
        var ns = $"{contextType.Namespace}.Migrations";
        var files = new Dictionary<string, string>
        {
            [$"Migrations/{id}.cs"] = generator.GenerateMigration(ns, name, up, down),
            [$"Migrations/{id}.Designer.cs"] = generator.GenerateMetadata(ns, contextType, name, id, model),
            [$"Migrations/{contextType.Name}ModelSnapshot.cs"] = generator.GenerateSnapshot(ns, contextType, $"{contextType.Name}ModelSnapshot", model),
        };
        steps.Add(new Dictionary<string, object> { ["files"] = files, ["model"] = Describe(model) });
        previous = model;
    }
    return steps;
}

static Dictionary<string, object> Describe(IModel model)
{
    var tables = new List<Dictionary<string, object?>>();
    foreach (var table in model.GetRelationalModel().Tables.OrderBy(t => t.Name))
    {
        var columns = table.Columns.Select(column => new Dictionary<string, object?>
        {
            ["name"] = column.Name,
            ["storeType"] = column.StoreType,
            // The type the provider stores: an enum with a string converter is a string.
            ["clrType"] = ProviderType(column.PropertyMappings.First()),
            ["nullable"] = column.IsNullable,
        }).ToList();
        tables.Add(new Dictionary<string, object?>
        {
            ["schema"] = table.Schema,
            ["name"] = table.Name,
            ["columns"] = columns,
            ["primaryKey"] = table.PrimaryKey?.Columns.Select(c => c.Name).ToList() ?? new List<string>(),
            ["uniqueConstraints"] = table.UniqueConstraints
                .Where(constraint => constraint != table.PrimaryKey)
                .Select(constraint => constraint.Columns.Select(c => c.Name).ToList())
                .ToList(),
            ["indexes"] = table.Indexes.Select(index => new Dictionary<string, object?>
            {
                ["name"] = index.Name,
                ["unique"] = index.IsUnique,
                ["columns"] = index.Columns.Select(c => c.Name).ToList(),
                ["filter"] = index.Filter,
            }).ToList(),
            ["foreignKeys"] = table.ForeignKeyConstraints.Select(key => new Dictionary<string, object?>
            {
                ["columns"] = key.Columns.Select(c => c.Name).ToList(),
                ["principalSchema"] = key.PrincipalTable.Schema,
                ["principalTable"] = key.PrincipalTable.Name,
                ["principalColumns"] = key.PrincipalColumns.Select(c => c.Name).ToList(),
                ["onDelete"] = key.OnDeleteAction.ToString(),
            }).ToList(),
        });
    }
    return new Dictionary<string, object> { ["tables"] = tables };
}

static string ProviderType(IColumnMapping mapping)
{
    var type = mapping.TypeMapping.Converter?.ProviderClrType ?? mapping.Property.ClrType;
    type = Nullable.GetUnderlyingType(type) ?? type;
    return type.FullName ?? type.Name;
}

class Scenario
{
    public string Name { get; set; } = "";
    public string Provider { get; set; } = "sqlite";
    public List<string> Contexts { get; set; } = new();
    public List<string>? Names { get; set; }
}
