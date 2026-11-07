using Microsoft.EntityFrameworkCore;

// Table per type (SQLite, ToTable on the derived types): every type has its own table, and the key of a derived
// table is also a foreign key to the table of its base type. Version 2 adds a third level, a relation of a derived
// type and a column on each level.

namespace Tpt.V1
{
    public class Animal
    {
        public int Id { get; set; }
        public string Name { get; set; } = "";
        public DateTime Arrived { get; set; }
    }

    public class Cat : Animal
    {
        public int Lives { get; set; }
    }

    public class Dog : Animal
    {
        public string Breed { get; set; } = "";
    }

    public class ZooContext : DbContext
    {
        public ZooContext(DbContextOptions options) : base(options) { }
        public DbSet<Animal> Animals => Set<Animal>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<Animal>().ToTable("Animals");
            modelBuilder.Entity<Cat>().ToTable("Cats");
            modelBuilder.Entity<Dog>().ToTable("Dogs");
        }
    }
}

namespace Tpt.V2
{
    public class Animal
    {
        public int Id { get; set; }
        public string Name { get; set; } = "";
        public DateTime Arrived { get; set; }
        public string? Note { get; set; }
    }

    public class Cat : Animal
    {
        public int Lives { get; set; }
        public bool Indoor { get; set; }
    }

    public class Kitten : Cat
    {
        public string? Mother { get; set; }
    }

    public class Dog : Animal
    {
        public string Breed { get; set; } = "";
        public int? TrainerId { get; set; }
        public Trainer? Trainer { get; set; }
    }

    public class Trainer
    {
        public int Id { get; set; }
        public string Name { get; set; } = "";
        public List<Dog> Dogs { get; set; } = new();
    }

    public class ZooContext : DbContext
    {
        public ZooContext(DbContextOptions options) : base(options) { }
        public DbSet<Animal> Animals => Set<Animal>();
        public DbSet<Trainer> Trainers => Set<Trainer>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<Animal>().ToTable("Animals");
            modelBuilder.Entity<Cat>().ToTable("Cats");
            modelBuilder.Entity<Kitten>().ToTable("Kittens");
            modelBuilder.Entity<Dog>().ToTable("Dogs");
        }
    }
}

// Table per type on PostgreSQL, chosen with UseTptMappingStrategy and without any ToTable call.

namespace TptPg.V1
{
    public abstract class Vehicle
    {
        public Guid Id { get; set; }
        public string Plate { get; set; } = "";
    }

    public class Car : Vehicle
    {
        public int Doors { get; set; }
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

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<Vehicle>().UseTptMappingStrategy();
        }
    }
}

// Table per concrete type: the tables of Cat and Dog hold the columns of Animal too, and Animal has no table.

namespace Tpc.V1
{
    public abstract class Animal
    {
        public Guid Id { get; set; }
        public string Name { get; set; } = "";
    }

    public class Cat : Animal
    {
        public int Lives { get; set; }
    }

    public class Dog : Animal
    {
        public string Breed { get; set; } = "";
    }

    public class ZooContext : DbContext
    {
        public ZooContext(DbContextOptions options) : base(options) { }
        public DbSet<Cat> Cats => Set<Cat>();
        public DbSet<Dog> Dogs => Set<Dog>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<Animal>().UseTpcMappingStrategy();
        }
    }
}

namespace Tpc.V2
{
    public abstract class Animal
    {
        public Guid Id { get; set; }
        public string Name { get; set; } = "";
        public DateTime? Born { get; set; }
        public int? KeeperId { get; set; }
        public Keeper? Keeper { get; set; }
    }

    public class Keeper
    {
        public int Id { get; set; }
        public string Name { get; set; } = "";
        public List<Animal> Animals { get; set; } = new();
    }

    public class Cat : Animal
    {
        public int Lives { get; set; }
    }

    public class Kitten : Cat
    {
        public string? Mother { get; set; }
    }

    public class Dog : Animal
    {
        public string Breed { get; set; } = "";
    }

    public class ZooContext : DbContext
    {
        public ZooContext(DbContextOptions options) : base(options) { }
        public DbSet<Cat> Cats => Set<Cat>();
        public DbSet<Kitten> Kittens => Set<Kitten>();
        public DbSet<Dog> Dogs => Set<Dog>();
        public DbSet<Keeper> Keepers => Set<Keeper>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<Animal>().UseTpcMappingStrategy();
            modelBuilder.Entity<Animal>().HasIndex(animal => animal.Name);
        }
    }
}

// Table per type with a composite key (SQLite): the key of each derived table is the two columns of the key of the
// base table, and it is also the composite foreign key to it.

namespace TptComposite.V1
{
    public abstract class Vehicle
    {
        public string Region { get; set; } = "";
        public int Number { get; set; }
        public string Plate { get; set; } = "";
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
        public DepotContext(DbContextOptions options) : base(options) { }
        public DbSet<Vehicle> Vehicles => Set<Vehicle>();
        public DbSet<Truck> Trucks => Set<Truck>();
        public DbSet<Van> Vans => Set<Van>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<Vehicle>().HasKey(v => new { v.Region, v.Number });
            modelBuilder.Entity<Vehicle>().ToTable("Vehicles");
            modelBuilder.Entity<Truck>().ToTable("Trucks");
            modelBuilder.Entity<Van>().ToTable("Vans");
        }
    }
}
