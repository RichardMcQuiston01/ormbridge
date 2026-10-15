namespace Blog.Models;

// Stored as its name ("Draft", "Published"): see HasConversion<string>() in PostConfiguration.
public enum PostStatus
{
    Draft,
    Published,
}
