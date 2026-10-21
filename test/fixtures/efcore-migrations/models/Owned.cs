using Microsoft.EntityFrameworkCore;

// Owned types: OwnsOne is flattened into the owner's table, OwnsMany (also nested) is a table with a foreign key.

namespace Owned.V1
{
    public class Geo
    {
        public double Lat { get; set; }
        public double Lng { get; set; }
    }

    public class Address
    {
        public string Street { get; set; } = "";
        public string? City { get; set; }
        public Geo Geo { get; set; } = new();
    }

    public class OrderLine
    {
        public string Sku { get; set; } = "";
        public int Quantity { get; set; }
    }

    public class Order
    {
        public string Number { get; set; } = "";
        public decimal Total { get; set; }
        public List<OrderLine> Lines { get; set; } = new();
    }

    public class Customer
    {
        public int Id { get; set; }
        public string Name { get; set; } = "";
        public Address Home { get; set; } = new();
        public Address? Work { get; set; }
        public List<Order> Orders { get; set; } = new();
    }

    public class ShopContext : DbContext
    {
        public ShopContext(DbContextOptions options) : base(options) { }
        public DbSet<Customer> Customers => Set<Customer>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<Customer>(customer =>
            {
                customer.OwnsOne(c => c.Home, home =>
                {
                    home.Property(a => a.Street).HasMaxLength(120);
                    home.OwnsOne(a => a.Geo);
                });
                customer.Navigation(c => c.Home).IsRequired();
                customer.OwnsOne(c => c.Work, work => work.OwnsOne(a => a.Geo));
                customer.OwnsMany(c => c.Orders, orders =>
                {
                    orders.OwnsMany(o => o.Lines);
                });
            });
        }
    }
}

namespace Owned.V2
{
    public class Geo
    {
        public double Lat { get; set; }
        public double Lng { get; set; }
    }

    public class Address
    {
        public string Street { get; set; } = "";
        public string? City { get; set; }
        public string? Zip { get; set; }
        public Geo Geo { get; set; } = new();
    }

    public class OrderLine
    {
        public string Sku { get; set; } = "";
        public int Quantity { get; set; }
        public decimal UnitPrice { get; set; }
    }

    public class Order
    {
        public string Number { get; set; } = "";
        public decimal Total { get; set; }
        public string? Notes { get; set; }
        public List<OrderLine> Lines { get; set; } = new();
    }

    public class Customer
    {
        public int Id { get; set; }
        public string Name { get; set; } = "";
        public Address Home { get; set; } = new();
        public Address? Work { get; set; }
        public List<Order> Orders { get; set; } = new();
    }

    public class ShopContext : DbContext
    {
        public ShopContext(DbContextOptions options) : base(options) { }
        public DbSet<Customer> Customers => Set<Customer>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<Customer>(customer =>
            {
                customer.OwnsOne(c => c.Home, home =>
                {
                    home.Property(a => a.Street).HasMaxLength(120);
                    home.OwnsOne(a => a.Geo);
                });
                customer.Navigation(c => c.Home).IsRequired();
                customer.OwnsOne(c => c.Work, work => work.OwnsOne(a => a.Geo));
                customer.OwnsMany(c => c.Orders, orders =>
                {
                    orders.OwnsMany(o => o.Lines);
                });
            });
        }
    }
}
