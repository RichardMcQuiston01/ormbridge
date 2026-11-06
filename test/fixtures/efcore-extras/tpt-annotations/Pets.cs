#nullable enable
using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;
using Microsoft.EntityFrameworkCore;

namespace Pets;

// Table per type with data annotations only: [Table] on every class of the hierarchy, a key with its own column name.

[Table("pet")]
public class Pet
{
    [Key]
    [Column("pet_no")]
    public int PetNo { get; set; }

    [Required, StringLength(40)]
    public string Name { get; set; } = null!;

    public int? OwnerNo { get; set; }

    [ForeignKey(nameof(OwnerNo))]
    public Owner? Owner { get; set; }
}

[Table("pet_bird")]
public class Bird : Pet
{
    [Column("wing_span")]
    public double WingSpan { get; set; }

    public bool CanFly { get; set; }
}

[Table("pet_fish")]
public class Fish : Pet
{
    [MaxLength(30)]
    public string? Water { get; set; }

    [Column("tank_no")]
    public int? TankNo { get; set; }

    [ForeignKey(nameof(TankNo))]
    public Tank? Tank { get; set; }
}

[Table("owner")]
public class Owner
{
    [Key]
    public int OwnerNo { get; set; }

    [Required]
    public string FullName { get; set; } = null!;

    public ICollection<Pet> Pets { get; set; } = new List<Pet>();
}

[Table("tank")]
public class Tank
{
    [Key]
    public int TankNo { get; set; }

    public int Litres { get; set; }

    public ICollection<Fish> Fishes { get; set; } = new List<Fish>();
}

public class PetsContext : DbContext
{
    public PetsContext(DbContextOptions<PetsContext> options)
        : base(options)
    {
    }

    public DbSet<Pet> Pets { get; set; } = null!;

    public DbSet<Bird> Birds { get; set; } = null!;

    public DbSet<Owner> Owners { get; set; } = null!;

    public DbSet<Tank> Tanks { get; set; } = null!;
}
