#nullable enable
using Microsoft.EntityFrameworkCore;

namespace Zoo;

public abstract class Animal
{
    public int Id { get; set; }

    public string Name { get; set; } = null!;

    public DateTime Arrived { get; set; }

    public int? KeeperId { get; set; }

    public Keeper? Keeper { get; set; }
}

public class Cat : Animal
{
    public int Lives { get; set; }

    public bool Indoor { get; set; }
}

public class Kitten : Cat
{
    public string? Mother { get; set; }

    public DateTime BornOn { get; set; }
}

public class Dog : Animal
{
    public string Breed { get; set; } = null!;

    public int? TrainerId { get; set; }

    public Trainer? Trainer { get; set; }
}

public class Keeper
{
    public int Id { get; set; }

    public string Name { get; set; } = null!;

    public List<Animal> Animals { get; set; } = new();
}

public class Trainer
{
    public int Id { get; set; }

    public string Name { get; set; } = null!;

    public List<Dog> Dogs { get; set; } = new();
}

public class ZooContext : DbContext
{
    public ZooContext(DbContextOptions<ZooContext> options)
        : base(options)
    {
    }

    public DbSet<Animal> Animals { get; set; } = null!;

    public DbSet<Keeper> Keepers { get; set; } = null!;

    public DbSet<Trainer> Trainers { get; set; } = null!;

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Animal>().ToTable("Animals");
        modelBuilder.Entity<Cat>().ToTable("Cats");
        modelBuilder.Entity<Kitten>().ToTable("Kittens");
        modelBuilder.Entity<Dog>().ToTable("Dogs");
    }
}
