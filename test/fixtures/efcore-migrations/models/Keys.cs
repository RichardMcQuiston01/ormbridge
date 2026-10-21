using Microsoft.EntityFrameworkCore;

// Keys and column kinds: a composite primary key, an alternate key that a foreign key references, a self reference,
// a one-to-one relationship whose key is the foreign key, a Guid key, defaults, a computed column, enums stored as
// numbers and as text, and the CLR types the shared model knows. V2 alters a few of them.

namespace Keys.V1
{
    public enum Status { Draft = 0, Published = 1 }

    public class Product
    {
        public int Id { get; set; }
        public string Sku { get; set; } = "";
        public decimal Price { get; set; }
        public List<Stock> Stocks { get; set; } = new();
    }

    public class Stock
    {
        public int Id { get; set; }
        public string ProductSku { get; set; } = "";
        public Product Product { get; set; } = null!;
        public long Quantity { get; set; }
    }

    public class Order
    {
        public Guid Id { get; set; }
        public Status Status { get; set; }
        public Status Review { get; set; }
        public DateOnly PlacedOn { get; set; }
        public TimeOnly PlacedAt { get; set; }
        public TimeSpan Window { get; set; }
        public byte[]? Signature { get; set; }
        public bool Paid { get; set; }
        public double Weight { get; set; }
        public short Priority { get; set; }
        public List<OrderItem> Items { get; set; } = new();
    }

    public class OrderItem
    {
        public Guid OrderId { get; set; }
        public Order Order { get; set; } = null!;
        public int LineNo { get; set; }
        public int Quantity { get; set; }
        public int Doubled { get; set; }
    }

    public class Employee
    {
        public int Id { get; set; }
        public string Name { get; set; } = "";
        public int? ManagerId { get; set; }
        public Employee? Manager { get; set; }
        public List<Employee> Reports { get; set; } = new();
        public EmployeeProfile? Profile { get; set; }
    }

    public class EmployeeProfile
    {
        public int EmployeeId { get; set; }
        public Employee Employee { get; set; } = null!;
        public string? Bio { get; set; }
    }

    public class KeysContext : DbContext
    {
        public KeysContext(DbContextOptions options) : base(options) { }
        public DbSet<Product> Products => Set<Product>();
        public DbSet<Stock> Stocks => Set<Stock>();
        public DbSet<Order> Orders => Set<Order>();
        public DbSet<OrderItem> OrderItems => Set<OrderItem>();
        public DbSet<Employee> Employees => Set<Employee>();
        public DbSet<EmployeeProfile> Profiles => Set<EmployeeProfile>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<Product>().HasAlternateKey(product => product.Sku);
            modelBuilder.Entity<Product>().Property(product => product.Price).HasColumnType("decimal(18,2)");
            modelBuilder.Entity<Stock>().HasOne(stock => stock.Product).WithMany(product => product.Stocks)
                .HasForeignKey(stock => stock.ProductSku).HasPrincipalKey(product => product.Sku);
            modelBuilder.Entity<Order>().Property(order => order.Status).HasConversion<string>().HasMaxLength(20);
            modelBuilder.Entity<Order>().Property(order => order.Paid).HasDefaultValue(true);
            modelBuilder.Entity<OrderItem>().HasKey(item => new { item.OrderId, item.LineNo });
            modelBuilder.Entity<OrderItem>().Property(item => item.Doubled)
                .HasComputedColumnSql("\"Quantity\" * 2", stored: true);
            modelBuilder.Entity<Employee>().HasOne(employee => employee.Manager).WithMany(employee => employee.Reports)
                .HasForeignKey(employee => employee.ManagerId).OnDelete(DeleteBehavior.Restrict);
            modelBuilder.Entity<EmployeeProfile>().HasKey(profile => profile.EmployeeId);
            modelBuilder.Entity<EmployeeProfile>().HasOne(profile => profile.Employee).WithOne(employee => employee.Profile)
                .HasForeignKey<EmployeeProfile>(profile => profile.EmployeeId);
        }
    }
}

namespace Keys.V2
{
    public enum Status { Draft = 0, Published = 1 }

    public class Product
    {
        public int Id { get; set; }
        public string Sku { get; set; } = "";
        public decimal Price { get; set; }
        public string? Barcode { get; set; }
        public List<Stock> Stocks { get; set; } = new();
    }

    public class Stock
    {
        public int Id { get; set; }
        public string ProductSku { get; set; } = "";
        public Product Product { get; set; } = null!;
        public long Quantity { get; set; }
    }

    public class Order
    {
        public Guid Id { get; set; }
        public Status Status { get; set; }
        public Status Review { get; set; }
        public DateOnly PlacedOn { get; set; }
        public TimeOnly PlacedAt { get; set; }
        public TimeSpan Window { get; set; }
        public byte[]? Signature { get; set; }
        public bool Paid { get; set; }
        public double Weight { get; set; }
        public int Priority { get; set; }
        public List<OrderItem> Items { get; set; } = new();
    }

    public class OrderItem
    {
        public Guid OrderId { get; set; }
        public Order Order { get; set; } = null!;
        public int LineNo { get; set; }
        public int Quantity { get; set; }
        public int Doubled { get; set; }
    }

    public class Employee
    {
        public int Id { get; set; }
        public string Name { get; set; } = "";
        public int? ManagerId { get; set; }
        public Employee? Manager { get; set; }
        public List<Employee> Reports { get; set; } = new();
        public EmployeeProfile? Profile { get; set; }
    }

    public class EmployeeProfile
    {
        public int EmployeeId { get; set; }
        public Employee Employee { get; set; } = null!;
        public string? Bio { get; set; }
    }

    public class KeysContext : DbContext
    {
        public KeysContext(DbContextOptions options) : base(options) { }
        public DbSet<Product> Products => Set<Product>();
        public DbSet<Stock> Stocks => Set<Stock>();
        public DbSet<Order> Orders => Set<Order>();
        public DbSet<OrderItem> OrderItems => Set<OrderItem>();
        public DbSet<Employee> Employees => Set<Employee>();
        public DbSet<EmployeeProfile> Profiles => Set<EmployeeProfile>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<Product>().HasAlternateKey(product => product.Sku);
            modelBuilder.Entity<Product>().Property(product => product.Price).HasColumnType("decimal(10,4)");
            modelBuilder.Entity<Product>().HasIndex(product => product.Barcode).IsUnique();
            modelBuilder.Entity<Stock>().HasOne(stock => stock.Product).WithMany(product => product.Stocks)
                .HasForeignKey(stock => stock.ProductSku).HasPrincipalKey(product => product.Sku);
            modelBuilder.Entity<Order>().Property(order => order.Status).HasConversion<string>().HasMaxLength(20);
            modelBuilder.Entity<Order>().Property(order => order.Paid).HasDefaultValue(false);
            modelBuilder.Entity<OrderItem>().HasKey(item => new { item.OrderId, item.LineNo });
            modelBuilder.Entity<OrderItem>().Property(item => item.Doubled)
                .HasComputedColumnSql("\"Quantity\" * 2", stored: true);
            modelBuilder.Entity<Employee>().HasOne(employee => employee.Manager).WithMany(employee => employee.Reports)
                .HasForeignKey(employee => employee.ManagerId).OnDelete(DeleteBehavior.Cascade);
            modelBuilder.Entity<EmployeeProfile>().HasKey(profile => profile.EmployeeId);
            modelBuilder.Entity<EmployeeProfile>().HasOne(profile => profile.Employee).WithOne(employee => employee.Profile)
                .HasForeignKey<EmployeeProfile>(profile => profile.EmployeeId);
        }
    }
}
