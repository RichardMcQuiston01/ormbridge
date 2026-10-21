using System.Net;
using Microsoft.EntityFrameworkCore;

// PostgreSQL (Npgsql): a schema, identity columns, uuid, timestamptz, arrays, jsonb with a GIN index, inet.
// V2 renames a column, alters a column and adds a table that references another schema.

namespace Pg.V1
{
    public class Account
    {
        public int Id { get; set; }
        public Guid PublicId { get; set; }
        public string Email { get; set; } = "";
        public DateTime CreatedAt { get; set; }
        public List<int> Scores { get; set; } = new();
        public string Settings { get; set; } = "{}";
        public IPAddress? LastIp { get; set; }
    }

    public class PgContext : DbContext
    {
        public PgContext(DbContextOptions options) : base(options) { }
        public DbSet<Account> Accounts => Set<Account>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.HasDefaultSchema("sales");
            modelBuilder.Entity<Account>().Property(account => account.Settings).HasColumnType("jsonb");
            modelBuilder.Entity<Account>().HasIndex(account => account.Settings).HasMethod("gin");
            modelBuilder.Entity<Account>().HasIndex(account => account.Email).IsUnique();
            modelBuilder.Entity<Account>().Property(account => account.PublicId).HasDefaultValueSql("gen_random_uuid()");
            modelBuilder.Entity<Account>().Property(account => account.CreatedAt).HasDefaultValueSql("now()");
        }
    }
}

namespace Pg.V2
{
    public class Account
    {
        public int Id { get; set; }
        public Guid PublicId { get; set; }
        public string Email { get; set; } = "";
        public DateTime CreatedAt { get; set; }
        public List<int> Scores { get; set; } = new();
        public string Settings { get; set; } = "{}";
        public IPAddress? LastAddress { get; set; }
        public long Balance { get; set; }
    }

    public class Invoice
    {
        public int Id { get; set; }
        public int AccountId { get; set; }
        public Account Account { get; set; } = null!;
        public decimal Amount { get; set; }
    }

    public class PgContext : DbContext
    {
        public PgContext(DbContextOptions options) : base(options) { }
        public DbSet<Account> Accounts => Set<Account>();
        public DbSet<Invoice> Invoices => Set<Invoice>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.HasDefaultSchema("sales");
            modelBuilder.Entity<Account>().Property(account => account.Settings).HasColumnType("jsonb");
            modelBuilder.Entity<Account>().HasIndex(account => account.Settings).HasMethod("gin");
            modelBuilder.Entity<Account>().HasIndex(account => account.Email).IsUnique();
            modelBuilder.Entity<Account>().Property(account => account.Email).HasMaxLength(200);
            modelBuilder.Entity<Account>().Property(account => account.PublicId).HasDefaultValueSql("gen_random_uuid()");
            modelBuilder.Entity<Account>().Property(account => account.CreatedAt).HasDefaultValueSql("now()");
            modelBuilder.Entity<Invoice>().ToTable("Invoices", "billing");
            modelBuilder.Entity<Invoice>().Property(invoice => invoice.Amount).HasPrecision(12, 2);
        }
    }
}
