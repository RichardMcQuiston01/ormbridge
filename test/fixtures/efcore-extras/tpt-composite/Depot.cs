#nullable enable
using Microsoft.EntityFrameworkCore;

namespace Depot;

public abstract class Vehicle
{
    public string Region { get; set; } = null!;

    public int Number { get; set; }

    public string Plate { get; set; } = null!;
}

public class Truck : Vehicle
{
    public decimal Payload { get; set; }
}

public class Van : Vehicle
{
    public int Seats { get; set; }
}

public class DepotContext : DbContext
{
    public DepotContext(DbContextOptions<DepotContext> options)
        : base(options)
    {
    }

    public DbSet<Vehicle> Vehicles => Set<Vehicle>();

    public DbSet<Truck> Trucks => Set<Truck>();

    public DbSet<Van> Vans => Set<Van>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Vehicle>().HasKey(v => new { v.Region, v.Number });
        modelBuilder.Entity<Vehicle>().UseTptMappingStrategy();
    }
}
