#nullable enable
using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;
using Microsoft.EntityFrameworkCore;

namespace Blog.Models;

[Table("blog_post")]
[Index(nameof(Title))]
[Index(nameof(PublicId), IsUnique = true)]
[Index(nameof(AuthorId), nameof(Title), IsUnique = true, Name = "uniq_post_author_title")]
[Index(nameof(PublishedAt), nameof(Status), Name = "post_pub_status_idx")]
public class Post : TimeStamped
{
    public int Id { get; set; }

    [Column("public_id")]
    public Guid PublicId { get; set; }

    [MaxLength(200)]
    public string Title { get; set; } = null!;

    public string Body { get; set; } = "";

    public PostStatus Status { get; set; }

    [Precision(4, 2)]
    public decimal? Rating { get; set; }

    [Column("view_count")]
    public int ViewCount { get; set; }

    [Column("is_featured")]
    public bool IsFeatured { get; set; }

    [Column("published_at")]
    public DateTime PublishedAt { get; set; }

    [Column(TypeName = "jsonb")]
    public string Metadata { get; set; } = "{}";

    [Column("author_id")]
    public int AuthorId { get; set; }

    public User Author { get; set; } = null!;

    [Column("editor_id")]
    public int? EditorId { get; set; }

    public User? Editor { get; set; }

    [Column("category_id")]
    public int CategoryId { get; set; }

    public Category Category { get; set; } = null!;

    public ICollection<Tag> Tags { get; set; } = new List<Tag>();
}
