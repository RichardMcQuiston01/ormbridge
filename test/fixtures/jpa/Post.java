package blog.models;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.JoinTable;
import jakarta.persistence.Lob;
import jakarta.persistence.ManyToMany;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;
import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.hibernate.annotations.ColumnDefault;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.annotations.OnDelete;
import org.hibernate.annotations.OnDeleteAction;
import org.hibernate.annotations.UuidGenerator;
import org.hibernate.type.SqlTypes;

@Entity
@Table(
    name = "blog_post",
    uniqueConstraints =
        @UniqueConstraint(
            name = "uniq_post_author_title",
            columnNames = {"author_id", "title"}),
    indexes = {
      @Index(name = "post_title_idx", columnList = "title"),
      @Index(name = "post_pub_status_idx", columnList = "published_at, status")
    })
public class Post extends TimeStamped {

  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Integer id;

  @UuidGenerator
  @Column(name = "public_id", nullable = false, unique = true)
  private UUID publicId;

  @Column(nullable = false, length = 200)
  private String title;

  @Lob
  @Column(nullable = false)
  private String body;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 20)
  @ColumnDefault("'Draft'")
  private PostStatus status;

  @Column(precision = 4, scale = 2)
  private BigDecimal rating;

  @Column(name = "view_count", nullable = false)
  @ColumnDefault("0")
  private int viewCount;

  @Column(name = "is_featured", nullable = false)
  @ColumnDefault("false")
  private boolean featured;

  @Column(name = "published_at", nullable = false)
  @ColumnDefault("CURRENT_TIMESTAMP")
  private LocalDateTime publishedAt;

  @JdbcTypeCode(SqlTypes.JSON)
  @Column(nullable = false)
  @ColumnDefault("'{}'")
  private Map<String, Object> metadata;

  @ManyToOne(optional = false, fetch = FetchType.LAZY)
  @JoinColumn(name = "author_id", nullable = false)
  @OnDelete(action = OnDeleteAction.CASCADE)
  private User author;

  @ManyToOne(fetch = FetchType.LAZY)
  @JoinColumn(name = "editor_id")
  @OnDelete(action = OnDeleteAction.SET_NULL)
  private User editor;

  @ManyToOne(optional = false, fetch = FetchType.LAZY)
  @JoinColumn(name = "category_id", nullable = false)
  @OnDelete(action = OnDeleteAction.RESTRICT)
  private Category category;

  @ManyToMany
  @JoinTable(
      name = "blog_post_tags",
      joinColumns = @JoinColumn(name = "post_id"),
      inverseJoinColumns = @JoinColumn(name = "tag_id"))
  private Set<Tag> tags = new HashSet<>();
}
