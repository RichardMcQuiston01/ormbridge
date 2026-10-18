package blog.models;

import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.OneToMany;
import jakarta.persistence.OneToOne;
import jakarta.persistence.Table;
import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "auth_user")
public class User {

  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Integer id;

  // Two collections point at Post, so mappedBy pairs them with Post.author and Post.editor.
  @OneToMany(mappedBy = "author")
  private List<Post> posts = new ArrayList<>();

  @OneToMany(mappedBy = "editor")
  private List<Post> editedPosts = new ArrayList<>();

  @OneToOne(mappedBy = "user")
  private Profile profile;
}
