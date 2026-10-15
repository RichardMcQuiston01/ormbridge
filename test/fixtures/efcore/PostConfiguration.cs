using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Blog.Models;

public class PostConfiguration : IEntityTypeConfiguration<Post>
{
    public void Configure(EntityTypeBuilder<Post> builder)
    {
        builder.Property(p => p.CreatedAt).HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.Property(p => p.UpdatedAt).ValueGeneratedOnAddOrUpdate();
        builder.Property(p => p.PublicId).HasDefaultValueSql("gen_random_uuid()");
        builder.Property(p => p.Status).HasConversion<string>().HasMaxLength(20).HasDefaultValue(PostStatus.Draft);
        builder.Property(p => p.ViewCount).HasDefaultValue(0);
        builder.Property(p => p.IsFeatured).HasDefaultValue(false);
        builder.Property(p => p.PublishedAt).HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.Property(p => p.Metadata).HasDefaultValueSql("'{}'");

        builder.HasOne(p => p.Author).WithMany(u => u.Posts).HasForeignKey(p => p.AuthorId).OnDelete(DeleteBehavior.Cascade);
        builder.HasOne(p => p.Editor).WithMany(u => u.EditedPosts).HasForeignKey(p => p.EditorId).OnDelete(DeleteBehavior.SetNull);
        builder.HasOne(p => p.Category).WithMany().HasForeignKey(p => p.CategoryId).OnDelete(DeleteBehavior.Restrict);

        builder
            .HasMany(p => p.Tags)
            .WithMany(t => t.Posts)
            .UsingEntity<Dictionary<string, object>>(
                "blog_post_tags",
                right => right.HasOne<Tag>().WithMany().HasForeignKey("tag_id"),
                left => left.HasOne<Post>().WithMany().HasForeignKey("post_id"),
                join => join.ToTable("blog_post_tags"));
    }
}
