using Microsoft.EntityFrameworkCore;

// Table per hierarchy: one table with a discriminator and the columns of every derived type.

namespace Fleet.V1
{
    public abstract class Vehicle
    {
        public int Id { get; set; }
        public string Plate { get; set; } = "";
    }

    public class Car : Vehicle
    {
        public int Seats { get; set; }
    }

    public class Truck : Vehicle
    {
        public decimal Payload { get; set; }
    }

    public class FleetContext : DbContext
    {
        public FleetContext(DbContextOptions options) : base(options) { }
        public DbSet<Vehicle> Vehicles => Set<Vehicle>();
        public DbSet<Car> Cars => Set<Car>();
        public DbSet<Truck> Trucks => Set<Truck>();
    }
}

namespace Fleet.V2
{
    public abstract class Vehicle
    {
        public int Id { get; set; }
        public string Plate { get; set; } = "";
    }

    public class Car : Vehicle
    {
        public int Seats { get; set; }
    }

    public class Truck : Vehicle
    {
        public decimal Payload { get; set; }
        public int Axles { get; set; }
    }

    public class FleetContext : DbContext
    {
        public FleetContext(DbContextOptions options) : base(options) { }
        public DbSet<Vehicle> Vehicles => Set<Vehicle>();
        public DbSet<Car> Cars => Set<Car>();
        public DbSet<Truck> Trucks => Set<Truck>();
    }
}
