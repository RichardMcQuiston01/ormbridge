#nullable enable
using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;
using Microsoft.EntityFrameworkCore;

namespace Blog.Models;

[Table("blog_profile")]
[Index(nameof(UserId), IsUnique = true)]
public class Profile
{
    public int Id { get; set; }

    [Column("user_id")]
    public int UserId { get; set; }

    public User User { get; set; } = null!;

    public string? Bio { get; set; }

    [MaxLength(100)]
    public string? Avatar { get; set; }
}
