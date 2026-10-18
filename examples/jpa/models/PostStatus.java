package blog.models;

// Stored as its name ("Draft", "Published"): see @Enumerated(EnumType.STRING) on Post.status.
public enum PostStatus {
  Draft,
  Published,
}
