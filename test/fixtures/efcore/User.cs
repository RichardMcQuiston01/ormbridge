#nullable enable
using System.ComponentModel.DataAnnotations.Schema;

namespace Blog.Models;

[Table("auth_user")]
public class User
{
    public int Id { get; set; }

    // Two collections point at Post, so PostConfiguration pairs them with Post.Author and Post.Editor.
    public ICollection<Post> Posts { get; set; } = new List<Post>();

    public ICollection<Post> EditedPosts { get; set; } = new List<Post>();

    public Profile? Profile { get; set; }
}
