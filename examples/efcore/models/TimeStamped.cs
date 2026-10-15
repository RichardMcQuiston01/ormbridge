#nullable enable
using System.ComponentModel.DataAnnotations.Schema;

namespace Blog.Models;

// Not an entity of its own (no DbSet): EF Core maps these properties into every entity that derives from it.
public abstract class TimeStamped
{
    [Column("created_at")]
    public DateTime CreatedAt { get; set; }

    [Column("updated_at")]
    public DateTime UpdatedAt { get; set; }
}
