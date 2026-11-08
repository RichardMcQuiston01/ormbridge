using Microsoft.EntityFrameworkCore;

// SQL Server: identity columns, nvarchar lengths and nvarchar(max), uniqueidentifier, datetime2, datetimeoffset, date,
// time, bit, tinyint, smallint, money, decimal, float, varbinary and a row version, default values and a computed column
// in SQL, a unique index with a filter, and cascade and restrict foreign keys. V2 renames a column, alters columns, drops
// a default and adds a table with a composite key that references the first.

namespace SqlServer.V1
{
    public class Customer
    {
        public int Id { get; set; }
        public Guid PublicId { get; set; }
        public string Name { get; set; } = "";
        public string? Notes { get; set; }
        public DateTime CreatedAt { get; set; }
        public DateTimeOffset? LastSeen { get; set; }
        public DateOnly? Born { get; set; }
        public TimeOnly OpensAt { get; set; }
        public bool Active { get; set; }
        public byte Level { get; set; }
        public short Rank { get; set; }
        public decimal Credit { get; set; }
        public decimal Balance { get; set; }
        public double Score { get; set; }
        public byte[]? Photo { get; set; }
        public byte[] Version { get; set; } = Array.Empty<byte>();
        public string FirstName { get; set; } = "";
        public string LastName { get; set; } = "";
        public string FullName { get; set; } = "";
    }

    public class Purchase
    {
        public long Id { get; set; }
        public int CustomerId { get; set; }
        public Customer Customer { get; set; } = null!;
        public decimal Total { get; set; }
    }

    public class ShopContext : DbContext
    {
        public ShopContext(DbContextOptions options) : base(options) { }
        public DbSet<Customer> Customers => Set<Customer>();
        public DbSet<Purchase> Purchases => Set<Purchase>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            var customer = modelBuilder.Entity<Customer>();
            customer.Property(c => c.Name).HasMaxLength(100);
            customer.Property(c => c.PublicId).HasDefaultValueSql("newid()");
            customer.Property(c => c.CreatedAt).HasDefaultValueSql("getutcdate()");
            customer.Property(c => c.Active).HasDefaultValue(true);
            customer.Property(c => c.Credit).HasColumnType("money");
            customer.Property(c => c.Balance).HasPrecision(18, 2);
            customer.Property(c => c.Version).IsRowVersion();
            customer.Property(c => c.FullName).HasComputedColumnSql("[FirstName] + N' ' + [LastName]", stored: true);
            customer.HasIndex(c => c.Name).IsUnique().HasFilter("[Active] = 1");
            modelBuilder.Entity<Purchase>().Property(p => p.Total).HasPrecision(12, 2);
        }
    }
}

namespace SqlServer.V2
{
    public class Customer
    {
        public int Id { get; set; }
        public Guid PublicId { get; set; }
        public string Name { get; set; } = "";
        public string? Notes { get; set; }
        public DateTime CreatedAt { get; set; }
        public DateTimeOffset? LastSeen { get; set; }
        public DateOnly? Born { get; set; }
        public TimeOnly OpensAt { get; set; }
        public bool Active { get; set; }
        public byte Level { get; set; }
        public short Rank { get; set; }
        public decimal Credit { get; set; }
        public decimal Balance { get; set; }
        public double Score { get; set; }
        public byte[]? Picture { get; set; }
        public byte[] Version { get; set; } = Array.Empty<byte>();
        public string FirstName { get; set; } = "";
        public string LastName { get; set; } = "";
        public string FullName { get; set; } = "";
    }

    public class Purchase
    {
        public long Id { get; set; }
        public int CustomerId { get; set; }
        public Customer Customer { get; set; } = null!;
        public decimal Total { get; set; }
    }

    public class PurchaseLine
    {
        public long PurchaseId { get; set; }
        public int LineNo { get; set; }
        public Purchase Purchase { get; set; } = null!;
        public string Sku { get; set; } = "";
        public int Quantity { get; set; }
    }

    public class ShopContext : DbContext
    {
        public ShopContext(DbContextOptions options) : base(options) { }
        public DbSet<Customer> Customers => Set<Customer>();
        public DbSet<Purchase> Purchases => Set<Purchase>();
        public DbSet<PurchaseLine> PurchaseLines => Set<PurchaseLine>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            var customer = modelBuilder.Entity<Customer>();
            customer.Property(c => c.Name).HasMaxLength(200);
            customer.Property(c => c.PublicId).HasDefaultValueSql("newid()");
            customer.Property(c => c.CreatedAt).HasDefaultValueSql("getutcdate()");
            customer.Property(c => c.Credit).HasColumnType("money");
            customer.Property(c => c.Balance).HasPrecision(18, 2);
            customer.Property(c => c.Version).IsRowVersion();
            customer.Property(c => c.FullName).HasComputedColumnSql("[FirstName] + N' ' + [LastName]", stored: true);
            customer.HasIndex(c => c.Name).IsUnique().HasFilter("[Active] = 1");
            modelBuilder.Entity<Purchase>().Property(p => p.Total).HasPrecision(12, 2);
            modelBuilder.Entity<PurchaseLine>().HasKey(l => new { l.PurchaseId, l.LineNo });
            modelBuilder.Entity<PurchaseLine>().Property(l => l.Sku).HasMaxLength(40);
            modelBuilder.Entity<PurchaseLine>()
                .HasOne(l => l.Purchase)
                .WithMany()
                .HasForeignKey(l => l.PurchaseId)
                .OnDelete(DeleteBehavior.Restrict);
        }
    }
}
