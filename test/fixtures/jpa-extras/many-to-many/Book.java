package extras.m2m;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.ManyToMany;
import java.util.HashSet;
import java.util.Set;

@Entity
public class Book {
  @Id private Long id;

  private String title;

  // No @JoinTable: Hibernate names the table Book_Author, with the columns Book_id and authors_id.
  @ManyToMany private Set<Author> authors = new HashSet<>();
}
