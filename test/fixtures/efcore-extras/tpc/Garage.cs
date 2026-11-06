#nullable enable
using Microsoft.EntityFrameworkCore;

namespace Garage;

// Table per concrete type: the abstract Machine has no table, Car and Truck each hold every column of Machine, and
// Pickup (below Truck) holds the columns of Machine, Truck and its own. The tables are not linked to each other.

public abstract class Machine
{
    public Guid Id { get; set; }

    public string Serial { get; set; } = null!;

    public DateTime BuiltOn { get; set; }

    public int? DepotId { get; set; }

    public Depot? Depot { get; set; }
}

public class Car : Machine
{
    public int Doors { get; set; }
}

public class Truck : Machine
{
    public decimal Payload { get; set; }
}

public class Pickup : Truck
{
    public bool Cover { get; set; }
}

public class Depot
{
    public int Id { get; set; }

    public string City { get; set; } = null!;

    public List<Machine> Machines { get; set; } = new();
}

public class GarageContext : DbContext
{
    public GarageContext(DbContextOptions<GarageContext> options)
        : base(options)
    {
    }

    public DbSet<Depot> Depots { get; set; } = null!;

    public DbSet<Car> Cars { get; set; } = null!;

    public DbSet<Truck> Trucks { get; set; } = null!;

    public DbSet<Pickup> Pickups { get; set; } = null!;

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Machine>().UseTpcMappingStrategy();
        modelBuilder.Entity<Machine>().HasIndex(m => m.Serial).IsUnique();
    }
}
