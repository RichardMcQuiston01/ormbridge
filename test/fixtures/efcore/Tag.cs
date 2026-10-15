#nullable enable
using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace Blog.Models;

[Table("blog_tag")]
public class Tag
{
    public int Id { get; set; }

    [MaxLength(50)]
    public string Label { get; set; } = null!;

    public ICollection<Post> Posts { get; set; } = new List<Post>();
}
