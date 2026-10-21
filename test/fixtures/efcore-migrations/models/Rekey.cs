using Microsoft.EntityFrameworkCore;

// PostgreSQL: the primary key moves to another column, an alternate key takes over the old one, a foreign key
// changes its delete behavior, columns become nullable and not nullable, and a unique index is dropped.

namespace Rekey.V1
{
    public class Product
    {
        public int Id { get; set; }
        public string Code { get; set; } = "";
        public string Name { get; set; } = "";
        public string? Note { get; set; }
        public List<Item> Items { get; set; } = new();
    }

    public class Item
    {
        public int Id { get; set; }
        public int ProductId { get; set; }
        public Product Product { get; set; } = null!;
        public string? Label { get; set; }
    }

    public class RekeyContext : DbContext
    {
        public RekeyContext(DbContextOptions options) : base(options) { }
        public DbSet<Product> Products => Set<Product>();
        public DbSet<Item> Items => Set<Item>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<Product>().HasIndex(product => product.Code).IsUnique();
        }
    }
}

namespace Rekey.V2
{
    public class Product
    {
        public int Id { get; set; }
        public string Code { get; set; } = "";
        public string Name { get; set; } = "";
        public string? Note { get; set; }
        public List<Item> Items { get; set; } = new();
    }

    public class Item
    {
        public int Id { get; set; }
        public int ProductId { get; set; }
        public Product Product { get; set; } = null!;
        public string? Label { get; set; }
    }

    public class RekeyContext : DbContext
    {
        public RekeyContext(DbContextOptions options) : base(options) { }
        public DbSet<Product> Products => Set<Product>();
        public DbSet<Item> Items => Set<Item>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<Product>().HasKey(product => product.Code);
            modelBuilder.Entity<Product>().HasAlternateKey(product => product.Id);
            modelBuilder.Entity<Product>().Property(product => product.Id).ValueGeneratedNever();
            modelBuilder.Entity<Item>().HasOne(item => item.Product).WithMany(product => product.Items)
                .HasForeignKey(item => item.ProductId).HasPrincipalKey(product => product.Id);
        }
    }
}

namespace Rekey.V3
{
    public class Product
    {
        public int Id { get; set; }
        public string Code { get; set; } = "";
        public string? Name { get; set; }
        public string Note { get; set; } = "";
        public List<Item> Items { get; set; } = new();
    }

    public class Item
    {
        public int Id { get; set; }
        public int ProductId { get; set; }
        public Product Product { get; set; } = null!;
        public string? Label { get; set; }
    }

    public class RekeyContext : DbContext
    {
        public RekeyContext(DbContextOptions options) : base(options) { }
        public DbSet<Product> Products => Set<Product>();
        public DbSet<Item> Items => Set<Item>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<Product>().HasKey(product => product.Code);
            modelBuilder.Entity<Product>().HasAlternateKey(product => product.Id);
            modelBuilder.Entity<Product>().Property(product => product.Id).ValueGeneratedNever();
            modelBuilder.Entity<Product>().Property(product => product.Name).HasMaxLength(80);
            modelBuilder.Entity<Item>().HasOne(item => item.Product).WithMany(product => product.Items)
                .HasForeignKey(item => item.ProductId).HasPrincipalKey(product => product.Id)
                .OnDelete(DeleteBehavior.Restrict);
        }
    }
}
