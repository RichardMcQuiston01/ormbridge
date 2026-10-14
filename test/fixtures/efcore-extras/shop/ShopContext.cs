using Microsoft.EntityFrameworkCore;

namespace Shop;

public class ShopContext : DbContext
{
    public ShopContext(DbContextOptions<ShopContext> options)
        : base(options)
    {
    }

    public DbSet<Customer> Customers => Set<Customer>();

    public DbSet<Order> Orders { get; set; } = null!;

    public DbSet<Product> Products { get; set; } = null!;

    // OrderLine, Category and Coupon are found through navigation properties.

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.ApplyConfiguration(new OrderLineConfiguration());

        modelBuilder.Entity<Customer>(entity =>
        {
            entity.Property(c => c.Name).HasMaxLength(120);
            entity.Property(c => c.Email).HasMaxLength(254);
            entity.HasIndex(c => c.Email).IsUnique().HasDatabaseName("ux_customer_email");
            entity.Property(c => c.Tier).HasConversion<string>().HasMaxLength(10).HasDefaultValue(Tier.Bronze);
            entity.OwnsOne(c => c.BillingAddress);
            entity.OwnsOne(c => c.ShippingAddress, a =>
            {
                a.Property(x => x.Zip).HasColumnName("ship_zip").HasMaxLength(10);
            });
            entity.Ignore(c => c.Internal);
        });

        modelBuilder.Entity<Order>(entity =>
        {
            entity.ToTable("orders");
            entity.Property(o => o.Total).HasPrecision(12, 2);
            entity.Property(o => o.PlacedAt).HasDefaultValueSql("CURRENT_TIMESTAMP");
            entity.Property(o => o.Version).IsRowVersion();
            entity.HasOne(o => o.Customer).WithMany(c => c.Orders).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<Product>(entity =>
        {
            entity.HasIndex(p => p.Sku).IsUnique().HasDatabaseName("ux_product_sku");
            entity.HasIndex(p => new { p.Name, p.Rank });
            entity.Property(p => p.Name).HasMaxLength(120).IsRequired();
            entity.Property(p => p.Weight).HasDefaultValue(1.5);
            entity.Property(p => p.Active).HasDefaultValue(true);
            entity.HasMany(p => p.Categories).WithMany(c => c.Products);
        });
    }
}
