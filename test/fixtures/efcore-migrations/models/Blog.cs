using Microsoft.EntityFrameworkCore;

// Three versions of a blog model. Between the versions: a column is renamed, added, dropped and altered, a unique
// index is added, an index is dropped, a table is renamed, a many-to-many join table is dropped, a table with an
// optional foreign key (SET NULL) is added.

namespace Blog.V1
{
    public class Blog
    {
        public int Id { get; set; }
        public string Title { get; set; } = "";
        public string? Url { get; set; }
        public List<Post> Posts { get; set; } = new();
    }

    public class Post
    {
        public int Id { get; set; }
        public string Title { get; set; } = "";
        public string? Body { get; set; }
        public int BlogId { get; set; }
        public Blog Blog { get; set; } = null!;
        public DateTime PublishedAt { get; set; }
        public int Views { get; set; }
        public List<Tag> Tags { get; set; } = new();
    }

    public class Tag
    {
        public int Id { get; set; }
        public string Name { get; set; } = "";
        public List<Post> Posts { get; set; } = new();
    }

    public class BlogContext : DbContext
    {
        public BlogContext(DbContextOptions options) : base(options) { }
        public DbSet<Blog> Blogs => Set<Blog>();
        public DbSet<Post> Posts => Set<Post>();
        public DbSet<Tag> Tags => Set<Tag>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<Post>().HasIndex(post => post.Title);
            modelBuilder.Entity<Tag>().HasIndex(tag => tag.Name).IsUnique();
        }
    }
}

namespace Blog.V2
{
    public class Blog
    {
        public int Id { get; set; }
        public string Name { get; set; } = "";
        public string? Slug { get; set; }
        public List<Post> Posts { get; set; } = new();
    }

    public class Post
    {
        public int Id { get; set; }
        public string Title { get; set; } = "";
        public string? Body { get; set; }
        public int BlogId { get; set; }
        public Blog Blog { get; set; } = null!;
        public DateTime PublishedAt { get; set; }
        public int Views { get; set; }
        public decimal Rating { get; set; }
        public List<Label> Labels { get; set; } = new();
    }

    public class Label
    {
        public int Id { get; set; }
        public string Name { get; set; } = "";
        public List<Post> Posts { get; set; } = new();
    }

    public class BlogContext : DbContext
    {
        public BlogContext(DbContextOptions options) : base(options) { }
        public DbSet<Blog> Blogs => Set<Blog>();
        public DbSet<Post> Posts => Set<Post>();
        public DbSet<Label> Labels => Set<Label>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<Blog>().Property(blog => blog.Name).HasMaxLength(100);
            modelBuilder.Entity<Blog>().HasIndex(blog => blog.Slug).IsUnique();
            modelBuilder.Entity<Post>().Property(post => post.Title).HasMaxLength(200);
            modelBuilder.Entity<Post>().Property(post => post.Rating).HasPrecision(5, 2).HasDefaultValue(3m);
            modelBuilder.Entity<Label>().ToTable("Labels");
            modelBuilder.Entity<Label>().HasIndex(label => label.Name).IsUnique();
            modelBuilder.Entity<Post>().HasMany(post => post.Labels).WithMany(label => label.Posts);
        }
    }
}

namespace Blog.V3
{
    public class Blog
    {
        public int Id { get; set; }
        public string Name { get; set; } = "";
        public string? Slug { get; set; }
        public List<Post> Posts { get; set; } = new();
    }

    public class Author
    {
        public int Id { get; set; }
        public string Email { get; set; } = "";
        public List<Post> Posts { get; set; } = new();
    }

    public class Post
    {
        public int Id { get; set; }
        public string Title { get; set; } = "";
        public string? Body { get; set; }
        public int BlogId { get; set; }
        public Blog Blog { get; set; } = null!;
        public int? AuthorId { get; set; }
        public Author? Author { get; set; }
        public DateTime PublishedAt { get; set; }
        public int Views { get; set; }
        public decimal Rating { get; set; }
    }

    public class BlogContext : DbContext
    {
        public BlogContext(DbContextOptions options) : base(options) { }
        public DbSet<Blog> Blogs => Set<Blog>();
        public DbSet<Author> Authors => Set<Author>();
        public DbSet<Post> Posts => Set<Post>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<Blog>().Property(blog => blog.Name).HasMaxLength(100);
            modelBuilder.Entity<Blog>().HasIndex(blog => blog.Slug).IsUnique();
            modelBuilder.Entity<Author>().HasIndex(author => author.Email).IsUnique();
            modelBuilder.Entity<Post>().Property(post => post.Title).HasMaxLength(200);
            modelBuilder.Entity<Post>().Property(post => post.Rating).HasPrecision(5, 2).HasDefaultValue(3m);
            modelBuilder.Entity<Post>().HasOne(post => post.Author).WithMany(author => author.Posts)
                .HasForeignKey(post => post.AuthorId).OnDelete(DeleteBehavior.SetNull);
        }
    }
}
