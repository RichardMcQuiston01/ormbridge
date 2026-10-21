#nullable enable
using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;
using Microsoft.EntityFrameworkCore;

namespace Orders;

// Owned collections (OwnsMany): each one is a table with a foreign key to its owner. A collection of an [Owned] type,
// a collection inside a collection, a type owned by two owners, an owned collection with its own table name,
// an index, a column name and an owned type inside a collection.

public class Customer
{
    public int Id { get; set; }

    [MaxLength(60)]
    public string Name { get; set; } = null!;

    public List<Order> Orders { get; set; } = new();
    public List<Note> Notes { get; set; } = new();
    public List<Tag> Tags { get; set; } = new();
}

public class Order
{
    public string Number { get; set; } = null!;
    public decimal Total { get; set; }
    public Address? Shipping { get; set; }
    public List<OrderLine> Lines { get; set; } = new();
}

public class OrderLine
{
    public string Sku { get; set; } = null!;
    public int Quantity { get; set; }
}

public class Address
{
    public string Street { get; set; } = null!;
    public string? City { get; set; }
}

public class Note
{
    public string Text { get; set; } = null!;
}

[Owned]
public class Tag
{
    public string Label { get; set; } = null!;
}

public class Supplier
{
    public Guid Id { get; set; }
    public string Name { get; set; } = null!;
    public List<Note> Notes { get; set; } = new();
    public List<Contact> Contacts { get; set; } = new();
}

public class Contact
{
    [Column("email_address")]
    public string Email { get; set; } = null!;

    public string? Phone { get; set; }
}

public class OrdersContext : DbContext
{
    public OrdersContext(DbContextOptions options) : base(options) { }

    public DbSet<Customer> Customers => Set<Customer>();
    public DbSet<Supplier> Suppliers => Set<Supplier>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Customer>(customer =>
        {
            customer.OwnsMany(c => c.Orders, orders =>
            {
                orders.Property(o => o.Total).HasPrecision(12, 2);
                orders.HasIndex(o => o.Number).IsUnique();
                orders.OwnsOne(o => o.Shipping);
                orders.OwnsMany(o => o.Lines);
            });
            customer.OwnsMany(c => c.Notes);
        });
        modelBuilder.Entity<Supplier>(supplier =>
        {
            supplier.OwnsMany(s => s.Notes);
            supplier.OwnsMany(s => s.Contacts, contacts => contacts.ToTable("supplier_contacts"));
        });
    }
}
