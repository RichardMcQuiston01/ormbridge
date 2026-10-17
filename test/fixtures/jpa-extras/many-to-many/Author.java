package extras.m2m;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.ManyToMany;
import java.util.HashSet;
import java.util.Set;

@Entity
public class Author {
  @Id private Long id;

  private String name;

  @ManyToMany(mappedBy = "authors")
  private Set<Book> books = new HashSet<>();
}
