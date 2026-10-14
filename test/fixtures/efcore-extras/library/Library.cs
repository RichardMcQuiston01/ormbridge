#nullable enable
using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;
using Microsoft.EntityFrameworkCore;

namespace Library;

[Table("authors")]
public class Author
{
    [Key]
    [DatabaseGenerated(DatabaseGeneratedOption.None)]
    public int AuthorNo { get; set; }

    [Required, StringLength(80)]
    public string FullName { get; set; } = null!;

    [Column("born_on", TypeName = "date")]
    public DateTime? BornOn { get; set; }

    [InverseProperty(nameof(Book.Author))]
    public ICollection<Book> Books { get; set; } = new List<Book>();

    [InverseProperty(nameof(Book.Reviewer))]
    public ICollection<Book> Reviewed { get; set; } = new List<Book>();
}

public class Book
{
    [Key]
    [MaxLength(13)]
    public string Isbn { get; set; } = null!;

    [StringLength(200, MinimumLength = 2)]
    public string Title { get; set; } = null!;

    public int AuthorNo { get; set; }

    [ForeignKey(nameof(AuthorNo))]
    public Author Author { get; set; } = null!;

    public int? ReviewerNo { get; set; }

    [ForeignKey("ReviewerNo")]
    public Author? Reviewer { get; set; }

    [Precision(8, 2)]
    [Comment("List price")]
    public decimal Price { get; set; }

    [ConcurrencyCheck]
    public int Revision { get; set; }

    [Timestamp]
    public byte[]? Stamp { get; set; }

    [NotMapped]
    public string Cached { get; set; } = "";

    public ICollection<Edition> Editions { get; set; } = new List<Edition>();
}

[PrimaryKey(nameof(BookIsbn), nameof(Number))]
[Index(nameof(Published), IsDescending = new[] { true })]
public class Edition
{
    [MaxLength(13)]
    public string BookIsbn { get; set; } = null!;

    public int Number { get; set; }

    public Book Book { get; set; } = null!;

    public DateTime Published { get; set; }
}

public class LibraryContext : DbContext
{
    public LibraryContext(DbContextOptions<LibraryContext> options)
        : base(options)
    {
    }

    public DbSet<Author> Authors => Set<Author>();

    public DbSet<Book> Books => Set<Book>();

    public DbSet<Edition> Editions => Set<Edition>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        // The client-side delete behaviors leave the constraint in the database without a cascading action.
        modelBuilder.Entity<Edition>().HasOne(e => e.Book).WithMany(b => b.Editions).OnDelete(DeleteBehavior.ClientCascade);
        modelBuilder.Entity<Book>().HasOne(b => b.Author).WithMany(a => a.Books).OnDelete(DeleteBehavior.ClientNoAction);
    }
}
