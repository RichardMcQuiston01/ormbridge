#nullable enable
using Microsoft.EntityFrameworkCore;

namespace Fleet;

public abstract class Vehicle
{
    public int Id { get; set; }

    public string Plate { get; set; } = null!;

    public DateTime RegisteredOn { get; set; }
}

public class Car : Vehicle
{
    public int Doors { get; set; }
}

public class Truck : Vehicle
{
    public decimal Capacity { get; set; }

    public string? Trailer { get; set; }
}

public class FleetContext : DbContext
{
    public FleetContext(DbContextOptions<FleetContext> options)
        : base(options)
    {
    }

    public DbSet<Vehicle> Vehicles { get; set; } = null!;

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Vehicle>()
            .HasDiscriminator<string>("Kind")
            .HasValue<Car>("car")
            .HasValue<Truck>("truck");
        modelBuilder.Entity<Vehicle>().HasIndex(v => v.Plate).IsUnique();
        modelBuilder.Entity<Car>();
        modelBuilder.Entity<Truck>();
    }
}
