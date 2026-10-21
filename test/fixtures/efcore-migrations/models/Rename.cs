using Microsoft.EntityFrameworkCore;

// The same classes, configured differently by each version, so EF Core sees renames: a table (and the foreign key
// that points at it), an index, and a column.

namespace Rename
{
    public class Writer
    {
        public int Id { get; set; }
        public string Name { get; set; } = "";
        public List<Book> Books { get; set; } = new();
    }

    public class Book
    {
        public int Id { get; set; }
        public string Title { get; set; } = "";
        public int WriterId { get; set; }
        public Writer Writer { get; set; } = null!;
    }

    public class RenameContextV1 : DbContext
    {
        public RenameContextV1(DbContextOptions options) : base(options) { }
        public DbSet<Writer> Writers => Set<Writer>();
        public DbSet<Book> Books => Set<Book>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<Book>().HasIndex(book => book.Title).HasDatabaseName("IX_Books_Title");
        }
    }

    public class RenameContextV2 : DbContext
    {
        public RenameContextV2(DbContextOptions options) : base(options) { }
        public DbSet<Writer> Writers => Set<Writer>();
        public DbSet<Book> Books => Set<Book>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<Writer>().ToTable("People");
            modelBuilder.Entity<Book>().HasIndex(book => book.Title).HasDatabaseName("IX_Books_ByTitle");
        }
    }

    public class RenameContextV3 : DbContext
    {
        public RenameContextV3(DbContextOptions options) : base(options) { }
        public DbSet<Writer> Writers => Set<Writer>();
        public DbSet<Book> Books => Set<Book>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<Writer>().ToTable("People");
            modelBuilder.Entity<Book>().HasIndex(book => book.Title).HasDatabaseName("IX_Books_ByTitle");
            modelBuilder.Entity<Book>().Property(book => book.Title).HasColumnName("Headline");
        }
    }
}
