#nullable enable
using Microsoft.EntityFrameworkCore;

namespace Shapes;

// Table per type chosen with UseTptMappingStrategy: no ToTable call, the tables are named after the DbSet properties
// (and after the type where there is none), and the derived types of the second level follow the strategy of the root.

public abstract class Shape
{
    public Guid Id { get; set; }

    public string Label { get; set; } = null!;
}

public class Circle : Shape
{
    public double Radius { get; set; }
}

public class Ring : Circle
{
    public double Inner { get; set; }
}

public class Polygon : Shape
{
    public int Sides { get; set; }

    public Guid? CanvasId { get; set; }

    public Canvas? Canvas { get; set; }
}

public class Canvas
{
    public Guid Id { get; set; }

    public string Title { get; set; } = null!;

    public List<Polygon> Polygons { get; set; } = new();
}

public class ShapesContext : DbContext
{
    public ShapesContext(DbContextOptions<ShapesContext> options)
        : base(options)
    {
    }

    public DbSet<Shape> Shapes { get; set; } = null!;

    public DbSet<Circle> Circles { get; set; } = null!;

    public DbSet<Ring> Rings { get; set; } = null!;

    public DbSet<Polygon> Polygons { get; set; } = null!;

    public DbSet<Canvas> Canvases { get; set; } = null!;

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Shape>().UseTptMappingStrategy();
    }
}
